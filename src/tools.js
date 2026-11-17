import { validateSelect, validateParams, GuardError } from "./guard.js";
import { execute, QueryError } from "./runner.js";

const quoteIdent = (name) => `"${name.replaceAll('"', '""')}"`;

/**
 * The four tool implementations, independent of MCP so they can be unit-tested.
 * Every call (success, rejection or error) is written to the audit log; if the
 * log cannot be written, the result is withheld (fail closed).
 */
export function createTools(config, audit) {
  async function run(tool, input, work) {
    const started = Date.now();
    const entry = { tool, input };
    try {
      const result = await work();
      entry.status = "ok";
      entry.rowCount = result.rows?.length ?? result.tables?.length;
      entry.truncated = result.truncated ?? false;
      return { ok: true, result };
    } catch (err) {
      entry.status = err instanceof GuardError ? "rejected" : "error";
      entry.error = err.message;
      return { ok: false, message: err.message };
    } finally {
      entry.durationMs = Date.now() - started;
      try {
        audit.append(entry);
      } catch (auditErr) {
        // fail closed: no audit trail, no data
        // eslint-disable-next-line no-unsafe-finally
        return { ok: false, message: `Audit log is not writable (${auditErr.message}); refusing to return data.` };
      }
    }
  }

  const internal = (sql, params = [], maxRows = 1000) =>
    execute({ dbPath: config.dbPath, sql, params, maxRows, timeoutMs: config.timeoutMs });

  const toObjects = ({ columns, rows }) => rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));

  async function tableNames() {
    const r = await internal(
      "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
    );
    return toObjects(r);
  }

  async function requireTable(name) {
    if (typeof name !== "string" || name === "") throw new GuardError("table must be a non-empty string.");
    const all = await tableNames();
    const hit = all.find((t) => t.name === name);
    if (!hit) {
      throw new GuardError(`Unknown table "${name}". Available: ${all.map((t) => t.name).join(", ") || "(none)"}.`);
    }
    return hit;
  }

  const clampLimit = (limit) => {
    if (limit === undefined) return config.maxRows;
    if (!Number.isInteger(limit) || limit < 1) throw new GuardError("limit must be a positive whole number.");
    return Math.min(limit, config.maxRows);
  };

  return {
    list_tables: (input = {}) =>
      run("list_tables", input, async () => {
        const tables = [];
        for (const t of await tableNames()) {
          const c = await internal(`SELECT count(*) FROM ${quoteIdent(t.name)}`);
          tables.push({ name: t.name, type: t.type, rowCount: c.rows[0][0] });
        }
        return { tables };
      }),

    describe_table: (input) =>
      run("describe_table", input, async () => {
        const t = await requireTable(input?.table);
        const cols = await internal(
          "SELECT name, type, \"notnull\" AS not_null, dflt_value AS default_value, pk AS primary_key FROM pragma_table_info(?)",
          [t.name],
        );
        const fks = await internal(
          'SELECT "from" AS column_name, "table" AS references_table, "to" AS references_column FROM pragma_foreign_key_list(?)',
          [t.name],
        );
        const count = await internal(`SELECT count(*) FROM ${quoteIdent(t.name)}`);
        return {
          table: t.name,
          type: t.type,
          rowCount: count.rows[0][0],
          columns: toObjects(cols),
          foreignKeys: toObjects(fks),
        };
      }),

    sample_rows: (input) =>
      run("sample_rows", input, async () => {
        const t = await requireTable(input?.table);
        const limit = Math.min(clampLimit(input?.limit ?? 5), config.maxRows);
        const r = await internal(`SELECT * FROM ${quoteIdent(t.name)} LIMIT ?`, [limit], limit);
        return { table: t.name, columns: r.columns, rows: r.rows, truncated: false };
      }),

    run_query: (input) =>
      run("run_query", input, async () => {
        const sql = validateSelect(input?.sql);
        const params = validateParams(input?.params);
        const limit = clampLimit(input?.limit);
        const r = await execute({ dbPath: config.dbPath, sql, params, maxRows: limit, timeoutMs: config.timeoutMs });
        const result = { columns: r.columns, rows: r.rows, rowCount: r.rows.length, truncated: r.truncated };
        if (r.truncated) result.note = `Result cut off at ${limit} rows. Add filters, aggregates or a LIMIT.`;
        return result;
      }),
  };
}

export { QueryError, GuardError };

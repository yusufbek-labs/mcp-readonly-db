// Runs inside a short-lived child process (see runner.js). It opens the database
// READ-ONLY, installs a SQLite authorizer that only permits reading, runs ONE
// statement, and sends back at most `maxRows` rows. The parent can SIGKILL this
// process at any moment, which is how query timeouts are enforced.
import { DatabaseSync, constants as C } from "node:sqlite";

const MAX_CELL_CHARS = 2000;
// Pure introspection pragmas, reachable only through SELECT * FROM pragma_xxx(...).
// (The lexical guard separately rejects the PRAGMA keyword in user SQL.)
const SAFE_PRAGMAS = new Set(["table_info", "table_xinfo", "foreign_key_list", "index_list", "index_info", "index_xinfo"]);
const BLOCKED_FUNCTIONS = new Set(["load_extension", "readfile", "writefile", "fts3_tokenizer"]);

function cell(v) {
  if (typeof v === "string") {
    return v.length > MAX_CELL_CHARS ? v.slice(0, MAX_CELL_CHARS) + `...[truncated, ${v.length} chars]` : v;
  }
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array) return `<blob ${v.byteLength} bytes>`;
  return v;
}

function run({ dbPath, sql, params, maxRows }) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.enableDefensive(true);
    db.exec("PRAGMA query_only = ON"); // set BEFORE the authorizer forbids PRAGMA
    db.setAuthorizer((action, a1, a2) => {
      switch (action) {
        case C.SQLITE_SELECT:
        case C.SQLITE_READ:
        case C.SQLITE_RECURSIVE:
          return C.SQLITE_OK;
        case C.SQLITE_PRAGMA:
          return SAFE_PRAGMAS.has(String(a1).toLowerCase()) ? C.SQLITE_OK : C.SQLITE_DENY;
        case C.SQLITE_FUNCTION:
          return BLOCKED_FUNCTIONS.has(String(a2).toLowerCase()) ? C.SQLITE_DENY : C.SQLITE_OK;
        default:
          return C.SQLITE_DENY; // INSERT, UPDATE, DELETE, PRAGMA, ATTACH, CREATE, DROP, ...
      }
    });
    const stmt = db.prepare(sql);
    stmt.setReturnArrays(true);
    const columns = stmt.columns().map((c) => c.name);
    const rows = [];
    let truncated = false;
    for (const row of stmt.iterate(...params)) {
      if (rows.length >= maxRows) { truncated = true; break; }
      rows.push(row.map(cell));
    }
    return { ok: true, columns, rows, truncated };
  } finally {
    db.close();
  }
}

process.on("message", (msg) => {
  let result;
  try {
    result = run(msg);
  } catch (err) {
    result = { ok: false, kind: "sql", error: String(err?.message ?? err) };
  }
  process.send(result, () => process.exit(0));
});

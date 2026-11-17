/**
 * Layer 1 of 3: a lexical guard for run_query input.
 * (Layer 2 = SQLite authorizer callback, Layer 3 = read-only file handle;
 *  see runner.js / child.js.)  This layer exists to give the AI clear,
 * early error messages; it is NOT relied on as the only protection.
 */

export class GuardError extends Error {
  constructor(message) {
    super(message);
    this.name = "GuardError";
  }
}

export const MAX_SQL_LENGTH = 10_000;
export const MAX_PARAMS = 50;

const FORBIDDEN_KEYWORDS = new Set([
  "insert", "update", "delete", "drop", "create", "alter", "attach", "detach",
  "pragma", "vacuum", "reindex", "analyze", "begin", "commit", "rollback",
  "savepoint", "release", "truncate", "explain", "load_extension", "readfile",
  "writefile", "fts3_tokenizer", "returning",
]);

/**
 * Walks the SQL once, honouring SQLite quoting rules, and returns the SQL with
 * every quoted literal/identifier blanked out ("''") so keyword checks cannot be
 * fooled by text inside strings. Throws on comments and unterminated quotes.
 */
function stripQuoted(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      throw new GuardError("SQL comments (--) are not allowed.");
    }
    if (c === "/" && next === "*") {
      throw new GuardError("SQL comments (/* */) are not allowed.");
    }
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new GuardError("Unterminated quote in SQL.");
        if (sql[j] === c) {
          if (sql[j + 1] === c) { j += 2; continue; } // doubled quote = escaped
          break;
        }
        j++;
      }
      out += "''";
      i = j + 1;
      continue;
    }
    if (c === "[") {
      const j = sql.indexOf("]", i + 1);
      if (j === -1) throw new GuardError("Unterminated [identifier] in SQL.");
      out += "''";
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Validates a user-supplied SQL string. Returns the cleaned single statement
 * (trailing semicolon removed) or throws GuardError with an explanation.
 */
export function validateSelect(sql) {
  if (typeof sql !== "string") throw new GuardError("sql must be a string.");
  if (sql.length > MAX_SQL_LENGTH) {
    throw new GuardError(`SQL is too long (${sql.length} chars; limit ${MAX_SQL_LENGTH}).`);
  }
  if (sql.includes("\0")) throw new GuardError("SQL must not contain NUL characters.");
  if (sql.trim() === "") throw new GuardError("SQL is empty.");

  const stripped = stripQuoted(sql);

  const semi = stripped.indexOf(";");
  if (semi !== -1 && stripped.slice(semi + 1).trim() !== "") {
    throw new GuardError("Only one statement is allowed (found text after a semicolon).");
  }
  const body = (semi === -1 ? stripped : stripped.slice(0, semi)).trim();
  if (body === "") throw new GuardError("SQL is empty.");

  const words = body.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [];
  const first = words[0];
  if (first !== "select" && first !== "with") {
    throw new GuardError(`Only SELECT queries are allowed (statement starts with "${first ?? body.slice(0, 20)}").`);
  }
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (FORBIDDEN_KEYWORDS.has(w)) {
      throw new GuardError(`The keyword "${w.toUpperCase()}" is not allowed: this server is read-only.`);
    }
    if (w === "replace" && words[k + 1] === "into") {
      throw new GuardError('"REPLACE INTO" is not allowed: this server is read-only.');
    }
  }

  const original = sql.trim();
  return original.endsWith(";") ? original.slice(0, -1).trimEnd() : original;
}

/** Validates bound parameters: only strings, finite numbers and null. */
export function validateParams(params) {
  if (params === undefined) return [];
  if (!Array.isArray(params)) throw new GuardError("params must be an array.");
  if (params.length > MAX_PARAMS) throw new GuardError(`Too many parameters (limit ${MAX_PARAMS}).`);
  for (const [i, p] of params.entries()) {
    const ok = p === null || typeof p === "string" || (typeof p === "number" && Number.isFinite(p));
    if (!ok) throw new GuardError(`params[${i}] must be a string, a finite number or null.`);
  }
  return params;
}

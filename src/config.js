import path from "node:path";

export const HARD_MAX_ROWS = 1000;

function intFromEnv(env, name, def, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}="${raw}": must be a whole number between ${min} and ${max}.`);
  }
  return n;
}

/**
 * Reads configuration from environment variables.
 *   MCP_DB_PATH          path to the SQLite file          (default ./data/shop.db)
 *   MCP_MAX_ROWS         max rows returned per query      (default 200, max 1000)
 *   MCP_QUERY_TIMEOUT_MS kill a query after this long     (default 5000)
 *   MCP_AUDIT_LOG        append-only audit log file       (default ./logs/audit.log)
 */
export function loadConfig(env = process.env) {
  return {
    dbPath: path.resolve(env.MCP_DB_PATH || "./data/shop.db"),
    maxRows: intFromEnv(env, "MCP_MAX_ROWS", 200, 1, HARD_MAX_ROWS),
    timeoutMs: intFromEnv(env, "MCP_QUERY_TIMEOUT_MS", 5000, 100, 60000),
    auditLogPath: path.resolve(env.MCP_AUDIT_LOG || "./logs/audit.log"),
  };
}

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const CHILD = fileURLToPath(new URL("./child.js", import.meta.url));

export class QueryError extends Error {
  constructor(message, kind = "sql") {
    super(message);
    this.name = "QueryError";
    this.kind = kind;
  }
}

function friendly(message) {
  if (/not authorized|authoriz/i.test(message)) {
    return "Blocked by the database-level read-only guard: this statement tries to do something other than read data.";
  }
  if (/readonly database|attempt to write/i.test(message)) {
    return "Blocked: the database is opened read-only, writes are impossible.";
  }
  if (/unable to open|no such file/i.test(message)) {
    return "Could not open the database file. Check MCP_DB_PATH.";
  }
  return `SQL error: ${message}`;
}

/** Runs one validated statement in a child process with a hard timeout. */
export function execute({ dbPath, sql, params = [], maxRows, timeoutMs }) {
  if (!fs.existsSync(dbPath)) {
    return Promise.reject(new QueryError(`Database file not found: ${dbPath}. Run "npm run seed" or set MCP_DB_PATH.`, "config"));
  }
  return new Promise((resolve, reject) => {
    const child = fork(CHILD, [], {
      execArgv: ["--no-warnings", "--max-old-space-size=128"],
      stdio: ["ignore", "ignore", "pipe", "ipc"], // never touch the MCP stdout channel
      windowsHide: true,
    });
    let settled = false;
    let timer;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      fn(value);
    };
    child.stderr.resume();
    timer = setTimeout(
      () => finish(reject, new QueryError(`Query exceeded the ${timeoutMs} ms time limit and was cancelled. Add filters or a smaller scope.`, "timeout")),
      timeoutMs,
    );
    child.on("message", (res) => {
      if (res.ok) finish(resolve, { columns: res.columns, rows: res.rows, truncated: res.truncated });
      else finish(reject, new QueryError(friendly(res.error), "sql"));
    });
    child.on("error", (e) => finish(reject, new QueryError(`Could not start query worker: ${e.message}`, "internal")));
    child.on("exit", () =>
      finish(reject, new QueryError("Query worker stopped unexpectedly (possibly out of memory). Try a narrower query.", "internal")));
    child.send({ dbPath, sql, params, maxRows });
  });
}

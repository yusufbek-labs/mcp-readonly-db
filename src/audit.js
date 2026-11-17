import fs from "node:fs";
import path from "node:path";

/** Append-only JSON-lines audit log. The server only ever opens it with flag "a". */
export class AuditLog {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.closeSync(fs.openSync(file, "a")); // fail fast if not writable
  }

  /** Throws if the entry cannot be written (callers then withhold results: fail closed). */
  append(entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    fs.appendFileSync(this.file, line + "\n", { flag: "a" });
  }
}

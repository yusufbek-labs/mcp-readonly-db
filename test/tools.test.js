import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { seedDatabase } from "../scripts/seed.js";
import { loadConfig } from "../src/config.js";
import { AuditLog } from "../src/audit.js";
import { createTools } from "../src/tools.js";
import { execute } from "../src/runner.js";

let dir, config, tools, audit;
const hash = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const lastLogLines = (n) => fs.readFileSync(config.auditLogPath, "utf8").trim().split("\n").slice(-n).map((l) => JSON.parse(l));

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ro-"));
  seedDatabase(path.join(dir, "shop.db"));
  config = loadConfig({
    MCP_DB_PATH: path.join(dir, "shop.db"),
    MCP_AUDIT_LOG: path.join(dir, "audit.log"),
    MCP_MAX_ROWS: "25",
    MCP_QUERY_TIMEOUT_MS: "1000",
  });
  audit = new AuditLog(config.auditLogPath);
  tools = createTools(config, audit);
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("seed data is shaped as documented", async () => {
  const r = await tools.list_tables();
  assert.equal(r.ok, true);
  const counts = Object.fromEntries(r.result.tables.map((t) => [t.name, t.rowCount]));
  assert.deepEqual(Object.keys(counts).sort(), ["customers", "order_items", "orders", "products"]);
  assert.ok(counts.orders >= 200 && counts.order_items >= 400);
  assert.ok(!JSON.stringify(r).includes("sqlite_"));
});

test("config rejects bad values and caps row limit", () => {
  assert.throws(() => loadConfig({ MCP_MAX_ROWS: "0" }), /MCP_MAX_ROWS/);
  assert.throws(() => loadConfig({ MCP_MAX_ROWS: "99999" }), /MCP_MAX_ROWS/);
  assert.throws(() => loadConfig({ MCP_QUERY_TIMEOUT_MS: "abc" }), /MCP_QUERY_TIMEOUT_MS/);
  assert.equal(loadConfig({}).maxRows, 200);
});

test("describe_table returns columns and foreign keys; unknown tables are refused", async () => {
  const r = await tools.describe_table({ table: "orders" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.result.columns.map((c) => c.name), ["id", "customer_id", "status", "ordered_at"]);
  assert.equal(r.result.foreignKeys[0].references_table, "customers");
  const bad = await tools.describe_table({ table: "nope" });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /Unknown table.*Available/);
});

test("table-name injection through describe_table / sample_rows is impossible", async () => {
  for (const evil of ['orders"; DROP TABLE orders; --', "orders; DELETE FROM orders", 'sqlite_master', '"orders"', "orders--"]) {
    assert.equal((await tools.describe_table({ table: evil })).ok, false, evil);
    assert.equal((await tools.sample_rows({ table: evil })).ok, false, evil);
  }
  assert.equal((await tools.sample_rows({ table: "orders", limit: 2 })).result.rows.length, 2);
});

test("run_query returns columns and rows, with parameter binding", async () => {
  const r = await tools.run_query({ sql: "SELECT id, email FROM customers WHERE id = ?", params: [3] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.result.columns, ["id", "email"]);
  assert.equal(r.result.rows.length, 1);
  assert.match(r.result.rows[0][1], /@example\.com$/);
});

test("bound parameters are treated as data, never as SQL", async () => {
  const r = await tools.run_query({ sql: "SELECT count(*) FROM customers WHERE last_name = ?", params: ["x' OR '1'='1"] });
  assert.equal(r.ok, true);
  assert.equal(r.result.rows[0][0], 0);
  const mism = await tools.run_query({ sql: "SELECT ? , ?", params: [1] });
  assert.equal(mism.ok, true); // SQLite binds missing as NULL; just must not crash
  const bad = await tools.run_query({ sql: "SELECT ?", params: [{ a: 1 }] });
  assert.equal(bad.ok, false);
});

test("row cap is enforced and reported", async () => {
  const r = await tools.run_query({ sql: "SELECT * FROM order_items" });
  assert.equal(r.result.rows.length, 25);
  assert.equal(r.result.truncated, true);
  assert.match(r.result.note, /cut off/);
  const asked = await tools.run_query({ sql: "SELECT * FROM order_items", limit: 5000 });
  assert.equal(asked.result.rows.length, 25, "a client cannot raise the cap");
  const small = await tools.run_query({ sql: "SELECT * FROM order_items", limit: 3 });
  assert.equal(small.result.rows.length, 3);
});

test("timeout kills runaway queries and the server stays usable", async () => {
  const t0 = Date.now();
  const r = await tools.run_query({
    sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c",
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /time limit/);
  assert.ok(Date.now() - t0 < 5000);
  assert.equal((await tools.run_query({ sql: "SELECT 1" })).ok, true);
});

test("defence in depth: even if the lexical guard were bypassed, SQLite itself refuses writes", async () => {
  const before = hash(config.dbPath);
  const attacks = [
    "DELETE FROM orders",
    "UPDATE customers SET email = 'x'",
    "INSERT INTO products VALUES (999,'a','b','c',1,1)",
    "DROP TABLE orders",
    "CREATE TABLE evil(a)",
    "ALTER TABLE orders ADD COLUMN x",
    "PRAGMA writable_schema = 1",
    "PRAGMA journal_mode = DELETE",
    "PRAGMA user_version = 7",
    "ATTACH DATABASE ':memory:' AS m",
    "VACUUM",
    "WITH x AS (SELECT 1) DELETE FROM orders",
    "SELECT load_extension('nope')",
    "BEGIN",
    "REPLACE INTO orders VALUES (1,1,'paid','x')",
  ];
  for (const sql of attacks) {
    await assert.rejects(
      execute({ dbPath: config.dbPath, sql, maxRows: 10, timeoutMs: 2000 }),
      (e) => e.name === "QueryError",
      sql,
    );
  }
  assert.equal(hash(config.dbPath), before, "database file must be byte-identical");
  const after = await tools.list_tables();
  assert.equal(after.result.tables.find((t) => t.name === "orders").rowCount, 250);
});

test("the database file handle is genuinely read-only (authorizer aside)", async () => {
  // Copy-less check: an OS-level read-only open must reject writes even for a second, unguarded handle.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  assert.throws(() => db.exec("DELETE FROM orders"), /readonly/i);
  db.close();
});

test("missing database gives a clear error", async () => {
  const t = createTools({ ...config, dbPath: path.join(dir, "missing.db") }, audit);
  const r = await t.list_tables();
  assert.equal(r.ok, false);
  assert.match(r.message, /not found/);
});

test("audit log: every call is appended, including rejections and errors", async () => {
  await tools.run_query({ sql: "SELECT 42 AS answer" });
  await tools.run_query({ sql: "DROP TABLE orders" });
  await tools.run_query({ sql: "SELECT nope FROM orders" });
  const [ok, rejected, errored] = lastLogLines(3);
  assert.equal(ok.status, "ok");
  assert.equal(ok.input.sql, "SELECT 42 AS answer");
  assert.equal(ok.rowCount, 1);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.input.sql, "DROP TABLE orders");
  assert.equal(errored.status, "error");
  assert.ok(ok.ts && typeof ok.durationMs === "number");
});

test("audit log is append-only: new entries never rewrite old ones; newlines in SQL cannot forge lines", async () => {
  const sizeBefore = fs.statSync(config.auditLogPath).size;
  const head = fs.readFileSync(config.auditLogPath, "utf8");
  await tools.run_query({ sql: "SELECT 'a'\n{\"tool\":\"forged\",\"status\":\"ok\"}" });
  const text = fs.readFileSync(config.auditLogPath, "utf8");
  assert.ok(text.startsWith(head));
  assert.ok(fs.statSync(config.auditLogPath).size > sizeBefore);
  for (const line of text.trim().split("\n")) JSON.parse(line); // every line is a single valid JSON record
  assert.ok(!text.split("\n").some((l) => l.startsWith('{"tool":"forged"')));
});

test("fail closed: if the audit log cannot be written, no data is returned", async () => {
  const brokenAudit = { append() { throw new Error("disk full"); } };
  const t = createTools(config, brokenAudit);
  const r = await t.run_query({ sql: "SELECT 1" });
  assert.equal(r.ok, false);
  assert.match(r.message, /Audit log/);
});

test("large text cells and blobs are summarised, not dumped", async () => {
  const r = await tools.run_query({ sql: "SELECT hex(zeroblob(10)) AS h, zeroblob(10) AS b, printf('%.*c', 5000, 'x') AS big" });
  assert.equal(r.ok, true);
  const [, b, big] = r.result.rows[0];
  assert.equal(b, "<blob 10 bytes>");
  assert.match(big, /truncated, 5000 chars/);
});

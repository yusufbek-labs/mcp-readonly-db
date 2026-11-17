import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { seedDatabase } from "../scripts/seed.js";

const SERVER = fileURLToPath(new URL("../src/server.js", import.meta.url));
let dir, client, auditLog;

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content[0].text;
  return { isError: !!res.isError, text, json: res.isError ? null : JSON.parse(text) };
};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-e2e-"));
  const db = path.join(dir, "shop.db");
  auditLog = path.join(dir, "logs", "audit.log");
  seedDatabase(db);
  client = new Client({ name: "e2e-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { ...process.env, MCP_DB_PATH: db, MCP_AUDIT_LOG: auditLog, MCP_MAX_ROWS: "50", MCP_QUERY_TIMEOUT_MS: "1500" },
      stderr: "ignore",
    }),
  );
});

after(async () => {
  await client?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("server advertises exactly the four read-only tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["describe_table", "list_tables", "run_query", "sample_rows"]);
  for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, t.name);
});

test("list_tables over stdio", async () => {
  const r = await call("list_tables");
  assert.equal(r.isError, false);
  assert.deepEqual(r.json.tables.map((t) => t.name), ["customers", "order_items", "orders", "products"]);
});

test("describe_table over stdio", async () => {
  const r = await call("describe_table", { table: "order_items" });
  assert.equal(r.isError, false);
  assert.equal(r.json.columns.length, 5);
  assert.equal(r.json.foreignKeys.length, 2);
});

test("sample_rows over stdio", async () => {
  const r = await call("sample_rows", { table: "customers", limit: 3 });
  assert.equal(r.isError, false);
  assert.equal(r.json.rows.length, 3);
});

test("run_query over stdio: business question with parameters", async () => {
  const r = await call("run_query", {
    sql: "SELECT p.category, SUM(i.quantity * i.unit_price_cents) / 100.0 AS revenue " +
      "FROM order_items i JOIN products p ON p.id = i.product_id JOIN orders o ON o.id = i.order_id " +
      "WHERE o.status = ? GROUP BY p.category ORDER BY revenue DESC",
    params: ["delivered"],
  });
  assert.equal(r.isError, false);
  assert.equal(r.json.columns[0], "category");
  assert.ok(r.json.rows.length >= 3);
});

test("run_query over stdio: write attempts come back as tool errors and change nothing", async () => {
  for (const sql of ["DELETE FROM orders", "SELECT 1; DROP TABLE orders", "SELECT 1 -- x", "PRAGMA table_info(orders)", "ATTACH 'x' AS y"]) {
    const r = await call("run_query", { sql });
    assert.equal(r.isError, true, sql);
  }
  const count = await call("run_query", { sql: "SELECT count(*) FROM orders" });
  assert.equal(count.json.rows[0][0], 250);
});

test("row cap and timeout apply over stdio", async () => {
  const capped = await call("run_query", { sql: "SELECT * FROM order_items" });
  assert.equal(capped.json.rows.length, 50);
  assert.equal(capped.json.truncated, true);
  const slow = await call("run_query", {
    sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c",
  });
  assert.equal(slow.isError, true);
  assert.match(slow.text, /time limit/);
});

test("every call above was audited", () => {
  const lines = fs.readFileSync(auditLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const tools = new Set(lines.map((l) => l.tool));
  for (const t of ["list_tables", "describe_table", "sample_rows", "run_query"]) assert.ok(tools.has(t), t);
  assert.ok(lines.some((l) => l.status === "rejected"));
  assert.ok(lines.some((l) => l.status === "ok"));
});

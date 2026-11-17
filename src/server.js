#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { AuditLog } from "./audit.js";
import { createTools } from "./tools.js";

export function createServer(config) {
  const audit = new AuditLog(config.auditLogPath);
  const tools = createTools(config, audit);
  const server = new McpServer({ name: "mcp-readonly-db", version: "1.0.0" });

  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const reply = (r) =>
    r.ok
      ? { content: [{ type: "text", text: JSON.stringify(r.result) }] }
      : { content: [{ type: "text", text: r.message }], isError: true };

  server.registerTool(
    "list_tables",
    {
      title: "List tables",
      description: "List every table and view in the database with its row count. Start here.",
      inputSchema: {},
      annotations,
    },
    async () => reply(await tools.list_tables()),
  );

  server.registerTool(
    "describe_table",
    {
      title: "Describe a table",
      description: "Show a table's columns (name, type, nullability, primary key), foreign keys and row count.",
      inputSchema: { table: z.string().describe("Exact table or view name, as returned by list_tables") },
      annotations,
    },
    async ({ table }) => reply(await tools.describe_table({ table })),
  );

  server.registerTool(
    "sample_rows",
    {
      title: "Sample rows",
      description: "Return the first few rows of a table so you can see what the data looks like.",
      inputSchema: {
        table: z.string().describe("Exact table or view name"),
        limit: z.number().int().min(1).optional().describe("How many rows (default 5; capped by the server row limit)"),
      },
      annotations,
    },
    async ({ table, limit }) => reply(await tools.sample_rows({ table, limit })),
  );

  server.registerTool(
    "run_query",
    {
      title: "Run a read-only SQL query",
      description:
        "Run ONE read-only SQLite SELECT statement (WITH ... SELECT is fine). Writes, PRAGMA, ATTACH, comments and " +
        "multiple statements are rejected. Use ? placeholders with the params array instead of pasting values into SQL. " +
        "Results are capped at a row limit and queries are time-limited.",
      inputSchema: {
        sql: z.string().describe("A single SELECT statement"),
        params: z.array(z.union([z.string(), z.number(), z.null()])).optional().describe("Values for ? placeholders, in order"),
        limit: z.number().int().min(1).optional().describe("Max rows to return (capped by the server row limit)"),
      },
      annotations,
    },
    async ({ sql, params, limit }) => reply(await tools.run_query({ sql, params, limit })),
  );

  return server;
}

async function main() {
  const config = loadConfig();
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  // stdout belongs to the MCP protocol: log only to stderr.
  console.error(`mcp-readonly-db ready: db=${config.dbPath} maxRows=${config.maxRows} timeout=${config.timeoutMs}ms audit=${config.auditLogPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}

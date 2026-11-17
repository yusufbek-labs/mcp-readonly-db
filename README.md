# mcp-readonly-db

**Let Claude answer questions about your business data, without ever being able to change it.**

> This is a **sample / portfolio project**. It runs against a fictional online-shop database that the included script generates. It has not been deployed for any client or audited by a third party. Treat it as a worked example of how I approach "connect an AI assistant to company data safely".

## What it does

It is a small program (an [MCP server](https://modelcontextprotocol.io)) that sits between Claude and a SQLite database file. Claude can look at the tables and run questions against them, in plain English on your side and read-only SQL behind the scenes. It cannot add, edit, or delete anything.

Four tools are offered to Claude:

| Tool | What it is for |
|---|---|
| `list_tables` | See which tables exist and how many rows each has |
| `describe_table` | See a table's columns and how it links to other tables |
| `sample_rows` | Peek at the first few rows to understand the data |
| `run_query` | Run one read-only `SELECT` query (with safe `?` parameters) |

Everything runs on your own computer. There are no network calls, no telemetry, and no accounts.

## 60-second setup

You need [Node.js](https://nodejs.org) **24 or newer** (it uses Node's built-in SQLite, so nothing needs compiling).

```bash
git clone <this repository>   # or copy the folder
cd mcp-readonly-db
npm install
npm run seed                  # creates data/shop.db with fictional shop data
npm test                      # optional: 38 tests
```

### Claude Desktop

Open *Settings > Developer > Edit Config* and add this to `claude_desktop_config.json` (use **absolute paths**; on Windows, double the backslashes):

```json
{
  "mcpServers": {
    "shop-db": {
      "command": "node",
      "args": ["C:\\path\\to\\mcp-readonly-db\\src\\server.js"],
      "env": {
        "MCP_DB_PATH": "C:\\path\\to\\mcp-readonly-db\\data\\shop.db",
        "MCP_AUDIT_LOG": "C:\\path\\to\\mcp-readonly-db\\logs\\audit.log"
      }
    }
  }
}
```

Restart Claude Desktop. The four tools appear under the tools menu.

### Claude Code

```bash
claude mcp add shop-db \
  --env MCP_DB_PATH=/path/to/mcp-readonly-db/data/shop.db \
  --env MCP_AUDIT_LOG=/path/to/mcp-readonly-db/logs/audit.log \
  -- node /path/to/mcp-readonly-db/src/server.js
```

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `MCP_DB_PATH` | `./data/shop.db` | The SQLite file to expose |
| `MCP_MAX_ROWS` | `200` (max `1000`) | Most rows any single answer may contain |
| `MCP_QUERY_TIMEOUT_MS` | `5000` | A query running longer than this is stopped |
| `MCP_AUDIT_LOG` | `./logs/audit.log` | Where every request is recorded |

Relative paths depend on where the app was launched from, so use absolute paths in the Claude config.

## Example questions to ask

- "What tables do we have, and how are they connected?"
- "Which 5 products brought in the most revenue from delivered orders?"
- "How many orders were cancelled or refunded each month this year?"
- "Which countries do our customers live in, and what is the average order value per country?"
- "Which products are low on stock (under 10) but still selling?"
- "Show me the customers who ordered more than three times."

Claude writes the SQL, runs it through `run_query`, and explains the result. You can read exactly what it ran in the audit log.

## Security model

Safety does not rest on one clever filter. Four independent layers each have to fail before a change could happen:

1. **Query checker (`src/guard.js`).** Before anything reaches the database, the text is checked: exactly one statement; must begin with `SELECT` (or `WITH ... SELECT`); no comments (`--`, `/* */`); no `INSERT`, `UPDATE`, `DELETE`, `DROP`, `CREATE`, `ALTER`, `ATTACH`, `PRAGMA`, `VACUUM`, `REPLACE INTO`, transaction commands, or file/extension functions. Quoted text is understood, so `'DROP TABLE'` inside a string is fine but a hidden second statement is not. Writing CTEs (`WITH x AS (...) DELETE ...`) are caught here. This layer gives Claude clear error messages so it can correct itself.
2. **SQLite authorizer (`src/child.js`).** SQLite itself is asked to approve every operation while compiling the query. Only reading is approved. Anything else is denied by the database engine, even if layer 1 had a gap.
3. **Read-only file handle.** The database is opened in read-only mode (plus `query_only`), so the engine refuses writes at the file level.
4. **Isolation and limits.** Each query runs in a separate short-lived process with a memory limit. If it exceeds the time limit, the process is killed. Results are cut at the row cap, and very long text cells are shortened.

Also:

- **Parameter binding.** Values go in a `params` list and are never pasted into the SQL, which removes the usual SQL-injection route. Table names given to `describe_table` / `sample_rows` must exactly match a real table.
- **Audit log.** Every request, including rejected and failed ones, is appended to a JSON-lines file with a timestamp, the SQL, parameters, outcome, row count and duration. The server only ever opens the file for appending. If the log cannot be written, the server returns no data (it fails closed).
- **No network, no telemetry, no secrets.** The server talks only to Claude through standard input/output. There are no credentials to leak.

The test suite attacks each layer separately (for example, it bypasses layer 1 on purpose and checks that layers 2 and 3 still stop the write and that the database file is byte-for-byte unchanged).

## Limitations (please read)

- **Sample project.** Built for demonstration; not production-hardened or independently security-reviewed.
- **Claude can read everything in the database.** Read-only is not the same as private. For real data, point it at a *copy or replica*, and leave out sensitive tables or columns. This sample has no per-column redaction.
- **What Claude reads goes to Anthropic** as part of the conversation, like anything else you paste into Claude. Check that this is acceptable for your data.
- **SQLite only**, one database file, no PostgreSQL/MySQL.
- **The checker is deliberately strict**, so it will occasionally refuse a harmless query. For example an unquoted column literally named `update` is rejected (quote it as `"update"`), and `EXPLAIN` / `PRAGMA` are not available. `describe_table` covers schema inspection instead.
- **The audit log is append-only as far as this program is concerned.** Someone with administrator access to the machine can still edit the file. For stronger guarantees, ship the log to a protected location.
- **Timeouts are per query**, and a determined user can still ask many expensive queries in a row. There is no rate limiting.
- **Uses Node's built-in `node:sqlite`**, which Node still labels experimental. It prints no output to the protocol stream, but its API could change in a future Node release.
- Tested on Windows 11 with Node 24.19 only. Not tested in Claude Desktop or Claude Code themselves (the end-to-end test uses the official MCP client SDK instead).

## Project layout

```
src/server.js   MCP wiring (stdio transport, four tools)
src/tools.js    tool logic + audit calls
src/guard.js    layer 1: query checker
src/child.js    layers 2-3: read-only open, authorizer, row cap
src/runner.js   spawns/kills the isolated query process (timeout)
src/audit.js    append-only JSON-lines log
src/config.js   environment variables
scripts/seed.js fictional shop data generator (deterministic)
test/           guard, tools/safety, and end-to-end tests (node:test)
```

## Sample data

`npm run seed` creates `customers` (80), `products` (29), `orders` (250) and `order_items` (~600). All names are invented, e-mail addresses use the reserved `example.com` domain, and the generator is deterministic so everyone gets the same data.

## License

MIT. See `LICENSE`.

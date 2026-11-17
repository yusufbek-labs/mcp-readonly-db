import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSelect, validateParams, GuardError, MAX_SQL_LENGTH } from "../src/guard.js";

const rejects = (sql, pattern) =>
  assert.throws(() => validateSelect(sql), (e) => e instanceof GuardError && (!pattern || pattern.test(e.message)), `should reject: ${sql}`);

test("accepts ordinary SELECTs", () => {
  assert.equal(validateSelect("SELECT * FROM orders"), "SELECT * FROM orders");
  assert.equal(validateSelect("  select 1;  "), "select 1");
  assert.equal(validateSelect("WITH t AS (SELECT 1 AS x) SELECT x FROM t"), "WITH t AS (SELECT 1 AS x) SELECT x FROM t");
  assert.equal(validateSelect("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<5) SELECT * FROM c").startsWith("WITH RECURSIVE"), true);
  validateSelect("SELECT CASE WHEN 1 THEN 'a' ELSE 'b' END");
  validateSelect("SELECT replace(name, 'a', 'b') FROM products");
  validateSelect("SELECT updated_at, created_at FROM t"); // keyword-like prefixes are fine
});

test("allows dangerous-looking text inside string literals and quoted identifiers", () => {
  validateSelect("SELECT 'DROP TABLE x; -- hi /* ok */' AS note");
  validateSelect("SELECT 'it''s; fine'");
  validateSelect('SELECT 1 AS "delete"');
  validateSelect("SELECT 1 AS [update]");
  validateSelect("SELECT * FROM products WHERE name = 'x;y'");
});

test("rejects non-SELECT statements", () => {
  for (const sql of [
    "INSERT INTO orders VALUES (1)",
    "UPDATE orders SET status='x'",
    "DELETE FROM orders",
    "DROP TABLE orders",
    "CREATE TABLE t(a)",
    "ALTER TABLE orders ADD COLUMN x",
    "REPLACE INTO orders VALUES (1)",
    "VACUUM",
    "REINDEX",
    "ANALYZE",
    "BEGIN",
    "COMMIT",
    "SAVEPOINT a",
    "EXPLAIN SELECT 1",
    "VALUES (1)",
  ]) rejects(sql);
});

test("rejects PRAGMA and ATTACH/DETACH in every position", () => {
  rejects("PRAGMA table_info(orders)", /Only SELECT/);
  rejects("pragma writable_schema = 1");
  rejects("ATTACH DATABASE 'x.db' AS x", /Only SELECT/);
  rejects("DETACH x");
  rejects("SELECT 1 WHERE (SELECT 1) AND 1 PRAGMA foo", /PRAGMA/);
});

test("rejects multiple statements", () => {
  rejects("SELECT 1; SELECT 2", /one statement/);
  rejects("SELECT 1; DROP TABLE orders", /one statement/);
  rejects("SELECT 1;;", /one statement|empty/i);
  rejects("SELECT 1;\n\n  DELETE FROM orders", /one statement/);
});

test("a single trailing semicolon is accepted", () => {
  assert.equal(validateSelect("SELECT 1 ;\n"), "SELECT 1");
});

test("rejects comments in all forms (comment-based bypass tricks)", () => {
  rejects("SELECT 1 -- trailing", /comment/i);
  rejects("SELECT 1 /* hidden */", /comment/i);
  rejects("SEL/**/ECT 1", /comment/i);
  rejects("SELECT 1 /*", /comment/i);
  rejects("SELECT 1 --\n; DROP TABLE x", /comment/i);
  rejects("SELECT 1/*!50000 UNION*/", /comment/i);
  rejects("/* x */ DELETE FROM orders", /comment/i);
});

test("rejects writing CTEs", () => {
  rejects("WITH x AS (SELECT 1) INSERT INTO orders SELECT * FROM x", /INSERT/);
  rejects("WITH x AS (SELECT 1) DELETE FROM orders", /DELETE/);
  rejects("WITH x AS (SELECT 1) UPDATE orders SET status='a'", /UPDATE/);
  rejects("WITH x AS (SELECT 1) REPLACE INTO orders SELECT 1", /REPLACE/);
  rejects("with x as (select 1) insert into orders select 1");
});

test("keyword check is case-insensitive and sees through odd whitespace", () => {
  rejects("SeLeCt 1 WHERE 1 UNION SELECT 1 FROM (DeLeTe FROM x)");
  rejects("WITH x AS (SELECT 1)\n\tINSERT\n INTO t SELECT 1");
  rejects("\n\n  dRoP table x");
});

test("rejects dangerous functions", () => {
  rejects("SELECT load_extension('evil.dll')", /LOAD_EXTENSION/);
  rejects("SELECT readfile('/etc/passwd')");
  rejects("SELECT writefile('x','y')");
  rejects("SELECT fts3_tokenizer('a')");
});

test("rejects RETURNING (write helper) and unterminated quotes", () => {
  rejects("SELECT 1 RETURNING x");
  rejects("SELECT 'abc", /Unterminated/);
  rejects('SELECT "abc', /Unterminated/);
  rejects("SELECT [abc", /Unterminated/);
});

test("quote tricks cannot hide a second statement", () => {
  rejects("SELECT 'a'; DELETE FROM orders; SELECT 'b'", /one statement/);
});

test("quote tricks: text after a closed string is still inspected", () => {
  rejects("SELECT 'a'' ' ; DELETE FROM orders", /one statement/);
  rejects("SELECT '' ; DROP TABLE orders", /one statement/);
});

test("rejects empty, non-string, NUL and oversized input", () => {
  rejects("");
  rejects("   ");
  rejects(";");
  rejects("SELECT 1\0; DROP TABLE x", /NUL/);
  rejects("SELECT '" + "a".repeat(MAX_SQL_LENGTH) + "'", /too long/);
  assert.throws(() => validateSelect(undefined), GuardError);
  assert.throws(() => validateSelect(42), GuardError);
  assert.throws(() => validateSelect({ toString: () => "select 1" }), GuardError);
});

test("validateParams accepts strings, numbers, null only", () => {
  assert.deepEqual(validateParams(undefined), []);
  assert.deepEqual(validateParams(["a", 1, 2.5, null]), ["a", 1, 2.5, null]);
  for (const bad of [[true], [{}], [[]], [NaN], [Infinity], [undefined], "x", { a: 1 }, [() => 1]]) {
    assert.throws(() => validateParams(bad), GuardError, JSON.stringify(bad));
  }
  assert.throws(() => validateParams(new Array(51).fill(1)), /Too many/);
});

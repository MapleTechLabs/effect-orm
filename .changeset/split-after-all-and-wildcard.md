---
"@maple-dev/effect-orm": patch
---

`splitTerminalClauses` now finds a `SETTINGS` or `FORMAT` clause that follows `ALL` or a `*` wildcard. `SELECT a, count() FROM t GROUP BY ALL FORMAT JSON`, `ALTER TABLE t DROP PARTITION ALL SETTINGS mutations_sync = 2` and `SELECT * FORMAT JSON` came back whole, clause included, because `ALL` and `*` were always read as wanting an operand after them. They are now read by what precedes them: `SELECT ALL x`, `UNION ALL SELECT` and `a * b` still take an operand.

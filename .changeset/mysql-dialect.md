---
"@maple-dev/effect-orm": minor
---

A new `/mysql` entry compiles the shared query builder for MySQL 8.0.17+ (`mysqlDialect`) and MariaDB 10.6+ (`mariadbDialect`), for `@effect/sql-mysql2` (#53). It writes backtick identifiers and positional `?` bindings (up to 65,535 per statement), escapes `\` in string literals, and writes `OFFSET` without `LIMIT` with MySQL's largest row count. It has MySQL column types and codecs for what mysql2 sends (`text`, `longtext`, `varchar(n)`, the integer types, `bigint` within 2^53, `double`, `decimal(p, s)` as exact text, `boolean`, `datetime` as `DATETIME(3)` in UTC, `date`, `blob`, `varbinary(n)`, `json(schema)`) and MySQL functions (`count`, `countDistinct`, `countIf`, `sum`, `avg`, `min`, `max`, `lower`, `upper`, `length`, `coalesce`), refused for another dialect in the type. `forUpdate` and `forShare` compile for MySQL, with MariaDB's `LOCK IN SHARE MODE`; the type refuses `forNoKeyUpdate` and `forKeyShare` there. RETURNING, ON CONFLICT, DISTINCT ON and ILIKE are refused at compile time. A transaction's isolation level and access mode go in the statement that starts it (`SET TRANSACTION …; START TRANSACTION READ ONLY`). `contains`, `startsWith` and `endsWith` compare bytes, so they stay case-sensitive under a case-insensitive collation. A JSON column is compared with `CAST(? AS JSON)` on MySQL. A selected small integer or numeric param is cast, as MySQL 8.4 can read it as an ORDER BY position inside a derived table. The fuzzer runs every property on MySQL 8.4 and MariaDB 11.4, over prepared statements and the text protocol Cloudflare Hyperdrive uses; see docs/mysql.md for what MySQL does differently.

Breaking, for a custom `Dialect`:

- `clauses.offsetRequiresLimit: true` is now `clauses.limitForOffset: "-1"`: the LIMIT to write, which MySQL needs to be its largest row count.
- `clauses.locking` is a `LockingSupport` (`{ strengths, of, shareSyntax? }`), not `true`: Postgres's is every strength with `of`.
- `likeIgnoresCase: true` is now `likeCase: "ascii-insensitive"`, beside `"sensitive"` (the default) and MySQL's `"collation"`.
- `integerComparesFraction: true` is now `fractionComparableIntegers`, the integer column types that compare with a fraction (SQLite's is `["integer"]`).

New optional `Dialect` fields: `castType` (the CAST target for a selected param's column type), `concat`, `comparisonCast` and `clauses.selectedNumberCast`. `MysqlOnly` and `LockingSupport` are exported from every dialect entry.

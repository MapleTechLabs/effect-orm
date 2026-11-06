# MySQL and MariaDB

Import `@maple-dev/effect-orm/mysql` for the shared query builder, MySQL codecs and functions.
`mysqlDialect` targets MySQL 8.0.17 and later (it casts to `DOUBLE`); `mariadbDialect` targets MariaDB 10.6 and later.
Both compile to backtick identifiers and positional `?` bindings, and the fuzzer runs every
property on MySQL 8.4 and MariaDB 11.4, over prepared statements and over the text protocol.
The package opens no connection: use the Effect `SqlClient` you already provide.

## Define and compile a query

```ts title="mysql-quickstart.ts"
import * as MySQL from "@maple-dev/effect-orm/mysql"

export const Tours = MySQL.table("tours", {
	id: MySQL.bigint,
	org_id: MySQL.varchar(36),
	title: MySQL.text,
	starts_at: MySQL.datetime,
}, { tenantColumn: "org_id" })

export const upcoming = MySQL.from(Tours)
	.select("id", "title", "starts_at")
	.where(($) => [$.org_id.eq(MySQL.param.string("orgId")), $.starts_at.gt(MySQL.param.dateTime("after"))])
	.orderBy(["starts_at", "asc"])
	.limit(20)

export const compiled = MySQL.compileUnsafe(upcoming, { orgId: "org_1", after: new Date("2026-01-01T00:00:00Z") })
// compiled.sql uses `tours`.`org_id` = ?; compiled.tenantScope is "single-tenant".

// MariaDB: pass its dialect, or provide it as CurrentDialect.
export const forMariadb = MySQL.compileUnsafe(upcoming, { orgId: "org_1", after: new Date() }, { dialect: MySQL.mariadbDialect })
```

`table(name, columns, options?)` is a query schema only. Pass `{ columns, primaryKey, indexes }`
to declare the table's DDL too.

## Declare a table with its DDL

With `{ columns, primaryKey, indexes }`, `table` returns a `MysqlSchemaTable`: still a query
`Table`, with its DDL beside it. `mysqlEntitiesOf` from `/schema` checks a set of tables as one
schema, and `renderMysqlSchema` writes their `CREATE TABLE` and `CREATE INDEX` statements:

```ts title="mysql-ddl.ts"
import { Effect, Schema } from "effect"
import * as S from "@maple-dev/effect-orm/schema"
import * as MySQL from "@maple-dev/effect-orm/mysql"

export const Tours = MySQL.table("tours", {
	casing: "snake_case",
	columns: {
		id: MySQL.bigint,
		orgId: MySQL.varchar(36),
		title: MySQL.column(MySQL.text, { default: "" }),
		tags: MySQL.column(MySQL.json(Schema.Array(Schema.String)), { default: [] }),
		seats: MySQL.column(MySQL.int, { default: 10 }),
		code: MySQL.column(MySQL.varchar(16), { unique: true }),
		startsAt: MySQL.column(MySQL.datetime, { defaultExpr: MySQL.dateTimeNow }),
	},
	primaryKey: ["orgId", "id"],
	indexes: [MySQL.index("tours_starts", ["orgId", "startsAt"])],
	tenantColumn: "orgId",
})

export const statements = S.mysqlEntitiesOf([Tours]).pipe(Effect.map(S.renderMysqlSchema))
// CREATE TABLE IF NOT EXISTS `tours` (
// 	`id` bigint NOT NULL,
// 	`org_id` varchar(36) NOT NULL,
// 	`title` text NOT NULL DEFAULT (''),
// 	`tags` json NOT NULL DEFAULT ('[]'),
// 	`seats` int NOT NULL DEFAULT 10,
// 	`code` varchar(16) NOT NULL,
// 	`starts_at` datetime(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
// 	PRIMARY KEY (`org_id`, `id`),
// 	CONSTRAINT `tours_code_unique` UNIQUE (`code`)
// ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
// CREATE INDEX `tours_starts` ON `tours` (`org_id`, `starts_at`)
```

- A column is `NOT NULL` unless its type is `nullable(...)`. A primary key column cannot be
  nullable: MySQL would make it `NOT NULL` without saying so.
- The primary key is a table constraint, `PRIMARY KEY (...)`; MySQL names every one `PRIMARY`.
  Tables are `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`; the collation is the server's default for
  utf8mb4. Indexes are separate `CREATE [UNIQUE] INDEX` statements (MySQL has no
  `CREATE INDEX IF NOT EXISTS`).
- `default` takes a literal of the column type. MySQL takes no literal default on a `TEXT`, `BLOB`
  or `JSON` column, so there it is written as an expression, `DEFAULT ('…')`, which MySQL 8.0.13+
  and MariaDB accept. `defaultExpr` takes SQL as written, so add the parentheses MySQL requires
  around an expression (`"(UUID())"`), or a DSL callback, which is parenthesized for you; a
  callback may not read another column. `dateTimeNow` is the `defaultExpr` for a `datetime`.
  Either lets an insert leave the column out.
- `unique: true` writes `CONSTRAINT <table>_<column>_unique UNIQUE (...)`; a string names it.
- An index takes column names. MariaDB has no index on an expression, so there is no callback form.
- A `TEXT`, `BLOB` or `JSON` column cannot be in the primary key, an index or a UNIQUE constraint:
  MySQL needs a prefix length there, which a column list cannot give. Use `varchar(n)`. A key over
  `varchar` columns must fit InnoDB's 3072 bytes, four a character in utf8mb4.
- Table, column, index and constraint names are plain identifiers of at most 64 characters. A
  table's indexes and UNIQUE constraints share one namespace, and `PRIMARY` is taken. Column names
  compare without case, so `Id` and `id` collide; so do two table names in one schema.
- `table(name, { external: true, columns })` declares a table another tool owns: no DDL.

The tests apply this DDL to MySQL 8.4 and MariaDB 11.4 and read every default back through the
builder. `effect-orm generate` with `dialect: "mysql"` diffs these tables against the migrations
folder and writes the next migration; see [MySQL migrations](./migrations.md#mysql).
effect-orm does not apply MySQL migrations yet, and has no MySQL introspection or drift check.
`AUTO_INCREMENT`, foreign keys, `CHECK` constraints, prefix and expression indexes and column
collations are not declared yet.

## Execute through `@effect/sql-mysql2`

Install `@effect/sql-mysql2` and give the pool `timezone: "Z"`, so a `DATETIME` is read and
written in UTC. With a `url`, put it in the URL (`?timezone=Z`), which mysql2 reads as an option.

```ts title="mysql-client.ts"
import * as MysqlClient from "@effect/sql-mysql2/MysqlClient"
import { Layer, Redacted } from "effect"
import * as Db from "@maple-dev/effect-orm/database"
import { mysqlDialect } from "@maple-dev/effect-orm/mysql"

export const MysqlLive = Db.layerSqlClient({
	dialect: mysqlDialect,
	requireTenantScope: true,
}).pipe(Layer.provide(MysqlClient.layer({ url: Redacted.make("mysql://app:secret@localhost:3306/app?timezone=Z") })))
```

For a proxy without prepared statements, such as Cloudflare Hyperdrive (as `@effect/sql-mysql2`
documents its `disablePreparedStatements` option), pass `disablePreparedStatements: true` to
`MysqlClient.layer`: mysql2 then writes each value into the statement, escaped. Both paths are
fuzzed. Over the text protocol the server prints some `DOUBLE` results one ULP off
(93188483.89857809 reads back as …808); prepared statements send the exact bits.

`Db.stream` reads through mysql2's row stream. Transactions and nested savepoints use the
client's `withTransaction`. `isolationLevel` (`read committed`, `repeatable read`,
`serializable`) and `accessMode` are applied by the statement that starts the transaction:
`SET TRANSACTION ISOLATION LEVEL …; START TRANSACTION READ ONLY`, since MySQL refuses
`SET TRANSACTION` inside a transaction. An isolation level therefore needs a client that runs
several statements in one; `@effect/sql-mysql2` does (it sets `multipleStatements`). An access
mode alone is one statement. `deferrable` is refused.

## Types

| Type | SQL | Decodes to |
| --- | --- | --- |
| `text`, `longtext`, `varchar(n)` | `text`, `longtext`, `varchar(n)` | `string` |
| `tinyint`, `smallint`, `int`, `intUnsigned` | the integer types | `number`, checked against the type's range |
| `bigint` | `bigint` | a safe JavaScript integer; a value past 2^53 is a decode error |
| `double` | `double` | `number` |
| `decimal(p, s)` | `decimal(p,s)` | the exact decimal text, as mysql2 sends it (`"12.5000"`) |
| `boolean` | `boolean` (`tinyint(1)`) | `boolean`, from 0/1; other integers fail |
| `datetime` | `datetime(3)` | `DateTime.Utc`, years 1000-9999 |
| `date` | `date` | `YYYY-MM-DD` text, a calendar date with no time zone |
| `blob`, `varbinary(n)` | `blob`, `varbinary(n)` | `Uint8Array` |
| `json(schema)` | `json` | the schema's type; MySQL sends JSON parsed, MariaDB as text |
| `nullable`, `custom`, `brand` | | type composition |

`MysqlType` is the descriptor type and `MysqlInteger` the integer wire codec. `dateTimeNow` is a
`defaultExpr` for a `datetime` column: `UTC_TIMESTAMP(3)`, since `CURRENT_TIMESTAMP` is in the
session's time zone and the column is read as UTC. A `DATETIME` itself is stored as written, so
mysql2's `timezone: "Z"` is all reading and writing need. And `mysqlDateTimeText(epochMillis)` is the `DATETIME(3)` text of an
instant, for raw SQL and seeds.

`date` refuses a day that does not exist. MariaDB's default `sql_mode` stores zero dates
(`2024-02-00`), which mysql2 turns into another day's `Date` before the codec sees it: run with
`NO_ZERO_IN_DATE,NO_ZERO_DATE`, or read DATE as text (mysql2's `dateStrings: ["DATE"]`).

A JSON column is compared with `CAST(? AS JSON)` on MySQL, which compares documents; MariaDB
compares the text.

An integer column compares with any number: `id.in_(-1)` on an `intUnsigned` column is false,
and `amount.gt(9.75)` compares numerically. Inserting a value outside the type is refused.

With `supportBigNumbers` (which `@effect/sql-mysql2` sets), mysql2 sends a `BIGINT` or a JSON
integer past 2^53 as a string. `bigint` refuses it; inside `json(schema)` the schema sees a
string, so declare such a field as one.

MySQL's own JSON parser reads some doubles up to one ULP off (`7.33277286497045e+62`), on every
path: a JSON column, `CAST(… AS JSON)` and `JSON_EXTRACT`. Store an exact number as `decimal` or
text.

## Functions

`count`, `countDistinct`, `countIf` (`COUNT(CASE WHEN … THEN 1 END)`), `sum`, `avg`, `min`, `max`,
`lower`, `upper`, `length` (`CHAR_LENGTH`: characters, not bytes) and `coalesce`. `sum` and `avg`
of integers are `DECIMAL`, which mysql2 sends as text; they decode to `number`. A function of
another dialect is refused in the type and at compile time.

## What differs from the other dialects

- **Text comparison follows the collation.** Under MySQL's default `utf8mb4_0900_ai_ci`, `=`,
  `GROUP BY`, `DISTINCT` and `like` ignore case and accents (`'a' = 'Á'`), and under a `PAD SPACE`
  collation such as `utf8mb4_bin` trailing spaces do not count (`'a' = 'a '`). Use a binary,
  no-pad collation (`utf8mb4_0900_bin` on MySQL, `utf8mb4_nopad_bin` on MariaDB) where text must
  match exactly; the fuzzer runs under these. A case-sensitive `contains`, `startsWith` or
  `endsWith` does not depend on it: it compares bytes (`CAST(x AS BINARY) LIKE …`).
  `{ insensitive: true }` compares `lower()` of both sides under the collation, so under an
  accent-insensitive one it ignores accents too (`'é'` matches `'e'`).
- **`/` is DECIMAL division.** `7 / 2` is `3.5000`: four places past the dividend's, nine kept
  internally. A comparison of a quotient sees the internal digits, and MySQL and MariaDB differ
  there (`1/3*3 = 1` is false on MySQL 8.4, true on MariaDB 11.4).
- **Unsigned arithmetic does not go below zero.** On an `UNSIGNED` column, `id - 5` fails with
  `BIGINT UNSIGNED value is out of range` when the result would be negative. Use a signed type,
  or `CAST`.
- **Not supported, and refused at compile time:** `RETURNING`, `ON CONFLICT` (MySQL's
  `ON DUPLICATE KEY UPDATE` reacts to every unique key, not one target), `DISTINCT ON`, `ILIKE`,
  `FOR NO KEY UPDATE` and `FOR KEY SHARE`. MariaDB has no lock `OF` at all.
- **Row locks:** `forUpdate` and `forShare` with `skipLocked`, `noWait` and, on MySQL, `of`.
  MariaDB writes a shared lock as `LOCK IN SHARE MODE`.
- **`NO_BACKSLASH_ESCAPES` is not supported.** String literals escape `\` with a backslash, as
  MySQL reads them by default. Bound values are unaffected. A literal containing the builder's
  reserved `__PARAM_` text is written as a `CONCAT` of parts.
- **OFFSET without LIMIT** is written with MySQL's largest row count.
- **MariaDB 11.4 pages `DISTINCT` over a join wrongly.** It counts `OFFSET` over the join's rows
  before `DISTINCT` removes their duplicates, so a page can repeat a row from the page before.
  Page a de-duplicated join from a subquery (`fromQuery(query.distinct(), "d")`) or with `groupBy`.
- A selected integer literal, and a selected `param.int`, `param.float` or `param.bool`, is
  written `CAST(… AS SIGNED)` (or `DOUBLE`): MySQL 8.4 replaces an alias with its expression
  inside a merged derived table, and would read `ORDER BY e1` over `10 AS e1` as column 10, an
  error, or over `1 AS e1` as the first column, silently. Over the text protocol a param is
  written into the SQL, so it needs the cast too. A literal of 2^63 or more is left as it is: MySQL
  reads it as a DECIMAL, no position.

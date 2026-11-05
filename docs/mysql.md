# MySQL and MariaDB

Import `@maple-dev/effect-orm/mysql` for the shared query builder, MySQL codecs and functions.
`mysqlDialect` targets MySQL 8.0 and later; `mariadbDialect` targets MariaDB 10.6 and later.
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

`table(name, columns, options?)` is a query schema only: it carries no DDL yet.

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

Cloudflare Hyperdrive does not support prepared statements: pass `disablePreparedStatements: true`
to `MysqlClient.layer`, and mysql2 writes each value into the statement, escaped. Both paths are
fuzzed.

`Db.stream` reads through mysql2's row stream. Transactions and nested savepoints use the
client's `withTransaction`. `isolationLevel` (`read committed`, `repeatable read`,
`serializable`) and `accessMode` are applied by the statement that starts the transaction:
`SET TRANSACTION ISOLATION LEVEL …; START TRANSACTION READ ONLY`, since MySQL refuses
`SET TRANSACTION` inside a transaction. `deferrable` is refused.

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

`MysqlType` is the descriptor type. `dateTimeNow` is a `defaultExpr` for a `datetime` column
(`CURRENT_TIMESTAMP(3)`), and `mysqlDateTimeText(epochMillis)` is the `DATETIME(3)` text of an
instant, for raw SQL and seeds.

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
  match exactly; the fuzzer runs under these. `contains`, `startsWith` and `endsWith` do not
  depend on it: a case-sensitive match compares bytes (`CAST(x AS BINARY) LIKE …`) and
  `{ insensitive: true }` compares `LOWER()` of both sides.
- **`/` is DECIMAL division.** `7 / 2` is `3.5000`: four places past the dividend's, nine kept
  internally. A comparison of a quotient sees the internal digits, and MySQL and MariaDB differ
  there (`1/3*3 = 1` is false on MySQL 8.4, true on MariaDB 11.4).
- **Unsigned arithmetic does not go below zero.** On an `UNSIGNED` column, `id - 5` fails with
  `BIGINT UNSIGNED value is out of range` when the result would be negative. Use a signed type,
  or `CAST`.
- **Not supported, and refused at compile time:** `RETURNING`, `ON CONFLICT` (MySQL's
  `ON DUPLICATE KEY UPDATE` reacts to every unique key, not one target), `DISTINCT ON`, `ILIKE`,
  `FOR NO KEY UPDATE` and `FOR KEY SHARE`. MariaDB has no `FOR SHARE OF`.
- **Row locks:** `forUpdate` and `forShare` with `skipLocked`, `noWait` and, on MySQL, `of`.
  MariaDB writes a shared lock as `LOCK IN SHARE MODE`.
- **`NO_BACKSLASH_ESCAPES` is not supported.** String literals escape `\` with a backslash, as
  MySQL reads them by default. Bound values are unaffected.
- **OFFSET without LIMIT** is written with MySQL's largest row count.
- A selected integer literal is written `CAST(10 AS SIGNED)`: MySQL 8.4 replaces an alias with its
  expression inside a merged derived table, and would read `ORDER BY e1` over `10 AS e1` as a
  column position.

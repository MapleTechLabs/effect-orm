# Troubleshooting

First identify which stage failed: installation, query construction/compilation, client execution,
or row decoding. [Running a query](./running-queries.md#error-boundaries) separates those boundaries.

## Installation and imports

| Symptom                                                      | Likely cause                                          | Fix                                                                                                  |
| ------------------------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| npm returns 404 for the builder                              | The package name or configured registry is incorrect.                     | Check `@maple-dev/effect-orm` and your npm registry; see [Getting started](./getting-started.md#installation-and-compatibility). |
| `Schema.TaggedError is not a function`                       | Effect 3 is installed or resolving ahead of Effect 4. | Install the documented Effect 4 version and inspect the resolved dependency tree.                    |
| `ERR_REQUIRE_ESM` or an import cannot be loaded by `require` | The builder ships ESM.                                | Use ESM imports and `"type": "module"`, or your bundler's ESM support.                               |
| A helper exists in source but not in the package             | A deep source import or stale local build.            | Use the public entry points in `package.json` `exports` and rebuild/reinstall your tarball.           |
| `@maple-dev/effect-orm` or `@maple-dev/effect-orm/types` cannot be resolved | Code written for the removed root and `/types` entries. | Import everything for one database from its entry (`/clickhouse`, `/postgres`, `/sqlite` or `/mysql`); write `CH.string`, not `T.string`. |
| The install warns about an unsupported engine, or `require()` of an entry fails on Node | Node is older than 20.19, the version `engines` declares. | Use Node 20.19+ (22.12+ on the 22 line) or Bun.                                                       |
| An example's `Events`, `Services`, or `CH` is undefined      | A guide fragment expects the shared schema/imports.   | Start with the complete example and shared `schema.ts`; recipe files include their own imports.      |
| `SchemaDefinitionError` from `entitiesOf` or `generate`      | A `table` definition is invalid, such as a MergeTree table without `orderBy`. | Read the message; pass `orderBy: []` for `ORDER BY tuple()`, or `external: true` for a table this schema does not own. |

## The `effect-orm` command

`effect-orm --help` lists the commands and flags; `effect-orm --version` prints the installed
package version (`ch-bench` takes both too).

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `unknown command "..."` | The command is not one of `generate`, `pull`, `check`, `migrate`, `status`, `verify`, `baseline`, `resolve`. It is checked before the config is read. | Check the spelling against `effect-orm --help`. |
| `Cannot import .../effect-orm.config.ts` | There is no config in the working directory, or it fails to load. | Run from the project root, or pass `--config <path>`. A `.ts` config or schema needs Bun, or Node with type stripping. |
| `this command needs a database: set \`driver\` in the config` | `migrate`, `status`, `verify`, `baseline`, `resolve` and `pull` read the database. | Add a `driver` to the config; see [Applying migrations](./migrations.md#applying-migrations). |
| `SQLite migrations are not run by effect-orm yet` (or MySQL) | `migrate` applies ClickHouse and Postgres folders only. | Apply the folder with a tool that reads drizzle-kit folders; see [SQLite migrations](./migrations.md#sqlite). |
| `pull reads ClickHouse only, for now` | `pull` has no Postgres, SQLite or MySQL reader yet. | Write the definitions by hand, then `generate --baseline`. |
| Exit code 2 from `generate` | A change needs a hint: it loses data, or it renames an enum label. | Pass `--hints` or `--hints-file` confirming it; see [Generating migrations](./migrations.md#generating-migrations). |
| Exit code 3 from `verify` | The database differs from the snapshot. | Read the reported drift before migrating. |

## Compilation failures

| Symptom                                     | Meaning                                                  | Fix                                                                                                               |
| ------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Nothing happens when calling `CH.compile`   | It returns an unrun Effect.                              | Use `yield*` in an Effect program or `await Effect.runPromise(...)`.                                              |
| `UnresolvedParam`                           | A placeholder has no value.                              | Match the case-sensitive name passed to `param.*` with the param bag.                                             |
| `InvalidLiteral`                            | A value does not encode through its codec, or a name spells the reserved param marker `__PARAM_` (Postgres, SQLite, MySQL). | Check type, finiteness, date format, and custom schema constraints; rename the key or alias.                      |
| `InvalidArguments`                          | A function received a value/argument list it cannot use. | Read the error message; inspect empty lists and function-specific limits.                                         |
| `QueryBuilderDefect`                        | The DSL was used incorrectly.                            | Supply `select`, use order tuples, and keep parameter names valid. Do not treat it as a retryable database error. |
| `.compileUnion` vs `.compile` type mismatch | Union queries have their own compiler.                   | Use `CH.compileUnion` for a union or wrap it with `CH.fromUnion` before `CH.compile`.                             |

Expected builder errors use the tag `@maple-dev/effect-orm/QueryBuilderError`.
[`catchTag`](./params-and-compilation.md#handling-compilation-failures) matches the full tag,
not just `QueryBuilderError`.

## Unexpected SQL or results

- **A tenant or time filter disappeared:** a later `.where()` replaced the earlier callback.
  Assemble the complete filter array once. Repeated `select`, `having`, and `orderBy` also replace.
- **`orderBy` errors:** use `.orderBy(["count", "desc"])`, not two bare strings.
- **An aggregate cannot be used in WHERE:** filter raw rows in WHERE and groups in HAVING.
- **Counts grew after a join:** multiple right-side rows matched. Include tenant keys and
  deduplicate/aggregate the joined source where your data model requires one row per key.
- **A LEFT JOIN returns empty strings or zeros:** ClickHouse uses defaults for unmatched columns
  with `join_use_nulls=0`; use `join_use_nulls=1` when you need NULLs, and match the decoder.
- **Arithmetic produces an unexpected value:** chained arithmetic follows SQL precedence;
  `.sub(1).div(2)` emits `x - 1 / 2`, not `(x - 1) / 2`. Use an intermediate subquery.
- **`tenantScope` is `"cross-tenant"`:** check every source, including joins, CTEs, and union
  branches. They must be bound to the same tenant. HAVING and OR are not scope evidence.
- **A query compiles but ClickHouse rejects it:** compilation is not a server-side semantic check.
  Check actual columns/types, aggregate rules, function availability, server version, and settings.
- **A ClickHouse select key, alias or CTE name is in backticks:** a name that is not plain
  (letters, digits, `_`, dots) is quoted, and so is a select key, alias or CTE name such as `all`,
  `null`, `select` or `top`, which ClickHouse would read as something else. The row comes back
  under the same key. Since 1.0.0, so SQL logged before it may differ. See
  [Names](./params-and-compilation.md#names).
- **ClickHouse refuses `ORDER BY all`:** 25.8 and 26.2 read `all` as "every column" whatever the
  quoting, unless `enable_order_by_all = 0`. Pick another key name.
- **MariaDB SQL selects `CAST(97 AS SIGNED) + 0` instead of `97`:** `mariadbDialect` writes a
  selected integer literal that way. MariaDB 11.4 sizes a bare literal one digit short in a union
  branch and cuts it to fit the other branch's type (`97` beside a `DECIMAL(5,4)` came back
  `9.9999`). MySQL is unchanged.

A `LIMIT` does not guarantee a cheap query: grouping or sorting can still scan many rows.
Use the real table's sorting key and bounded time filters; inspect the server plan rather than
assuming a typed query is optimized. See [Recipes](./recipes.md#time-buckets-over-a-bounded-interval).

## ClickHouse over HTTP (`/clickhouse-http`)

| Symptom | Meaning | Fix |
| --- | --- | --- |
| Every query fails with an unknown setting `http_write_exception_in_output_format` | The server is older than ClickHouse 23.9, the first with that setting. | Upgrade the server; the client needs 23.9 or later. |
| Every query of a `readonly = 1` user fails on a setting it may not change | The client sends `cancel_http_readonly_queries_on_client_close=1` and `http_write_exception_in_output_format=1`; a read-only user may only repeat a setting's current value. | Put both in `settings` with the server's values from `system.settings`: the first is usually `0`; the second is `1` before 25.11 and `0` from it. |
| A long query fails with a `ConnectionError` after rows arrived | The query failed after its first rows, with `http_write_exception_in_output_format = 0` (the read-only case on 25.11 and later). The rows read so far are not returned. | Let the client send the setting, or raise the limit that stopped the query. |
| A timeout is a `StatementTimeoutError`, a memory limit an `UnknownError` with the server's message | The query failed part way; the server's code arrived in the body after the rows. Before 1.0.0, a server older than 25.11 returned the partial rows as the result. | Treat it as a failed query. A `.stream` has already emitted the rows before the failure. |
| A bound `null` or `bigint` reaches the server differently than before 1.0.0 | `null` binds as SQL NULL, an array with a null as `Array(Nullable(T))`, and a `bigint` as the narrowest of `Int64`, `UInt64`, `Int128`, `UInt256`, `Int256` that holds it. | Check SQL that relied on the old text `'null'` or on a type default. |

See [On Workers and other fetch runtimes](./running-queries.md#on-workers-and-other-fetch-runtimes).

## Decode failures and lost information

`CompiledQueryDecodeError` reports `rowIndex`, the `column` and the `issues` (path and expected
type). It does not hold the wire value. Inspect that row's field names and wire values alongside
`compiled.rowSchemaSource`, `compiled.untypedColumns`, and `compiled.rowSchemaMismatch`. For the
raw Schema message, read `error.schemaError` or `formatDecodeError(error, { verbose: true })`
locally. Do not send it to shared logs: it can hold row values.

| Symptom                              | Check                                                                                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `rowSchemaSource` is `"none"`        | A selected expression has no codec, or the SQL is handwritten. Prefer typed helpers or supply a declared row schema.                          |
| A count arrives as `"42"`            | Use `CH.CHNumber` in a declared schema; the derived numeric codecs already accept quoted numbers.                                             |
| A field disappeared after decoding   | An explicit schema replaced the derived shape. Inspect `rowSchemaMismatch`.                                                                   |
| An ID's last digits changed          | The value passed through JavaScript `number`. Project `toString(...)` in SQL before parsing JSON.                                             |
| Timestamps shifted by several hours  | The codec assumes zone-less text is UTC, but the server/column emitted another timezone. Normalize SQL output or use a matching custom codec. |
| Microseconds/nanoseconds disappeared | Parsed `DateTime.Utc` has millisecond precision. Preserve the text with `CH.dateTime64String`.                                                 |
| An average/percentile is NULL        | Empty/non-finite aggregate results can serialize as JSON null. Keep the nullable type or explicitly define a fallback.                        |
| “No rows” crashes a point lookup     | Use `Db.runOption` (or `decodeFirstRow`) and handle `Option.none`; an empty result is not a decode failure.                                    |

The built-in numeric codecs are wire decoders, not full range validators. `CH.uint64` does not
make JavaScript numbers lossless or enforce UInt64 bounds. `CH.untyped` validates nothing for its
field even when the rest of the row has a derived schema.

## Reporting a problem

Include the package version (`effect-orm --version`), resolved Effect version, runtime, and the
database and its version. Reduce
the problem to a table declaration, a query, the parameter shapes, and the generated SQL.
For decoding failures include a redacted wire row and `rowSchemaSource`. Remove credentials
and personal data: parameters are interpolated into `compiled.sql`, so the SQL may contain
sensitive values. File a [GitHub issue](https://github.com/MapleTechLabs/effect-orm/issues).

# Effect ORM

`@maple-dev/effect-orm` builds ClickHouse and Postgres SQL from typed TypeScript. You describe a
table once, and the builder infers column types, output row shapes, and join accessors from
it. Queries are immutable values — every method returns a new query — and nothing touches the
network: the end product is a `CompiledQuery` holding a SQL string plus a typed decoder. You
bring your own database client.

Each database has one entry that holds everything for it, the way drizzle and kysely split
dialects: `import * as CH from "@maple-dev/effect-orm/clickhouse"` or
`import * as PG from "@maple-dev/effect-orm/postgres"`. The query builder is the same in both;
the column types, functions, table DDL, and `compile` are the database's own.

## Is this for your project?

Use the builder when you want typed ClickHouse or Postgres queries, reusable query definitions,
and runtime result decoding in TypeScript. It works with an ordinary async application as
well as an Effect application. The database client remains your choice.

You do not need a Maple account, Maple's schema, or tenant columns. Tenant analysis is an
optional feature for applications that share tables between tenants.

The builder does not manage connections, create tables, or run migrations. It builds
SELECTs, [INSERTs](./inserts.md), and [UPDATEs and DELETEs](./updates-and-deletes.md). Every
`table` carries its DDL, and opt-in [schema and migration entry points](./migrations.md) turn it
into migrations for ClickHouse and Postgres. It does not validate SQL against a live server,
choose query plans, enforce authorization, or supply retries. Your existing tables and your
executor own those responsibilities.
[Getting started](./getting-started.md) covers npm installation and building from source.

## Start here

1. [Compile and decode offline](./getting-started.md) with one complete file.
2. [Run a real query](./running-queries.md) against `system.numbers`, without creating a table.
3. [Adapt a recipe](./recipes.md) to your own schema.
4. [Benchmark a change](./benchmarking.md) with a fixed workload and saved baseline.
5. Consult [Troubleshooting](./troubleshooting.md) if installation or results differ from expectations.

The named complete examples are extracted from Markdown, typechecked, and exercised by
[`check-doc-examples.mjs`](../scripts/check-doc-examples.mjs). Focused behavior tests also live in
[`src/docs-examples.test.ts`](../src/docs-examples.test.ts). Client execution requires a server;
the offline checks verify SQL construction and decoding, not database execution plans.

## Guides

Roughly in reading order.

| Guide                                                 | What it covers                                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [Getting started](./getting-started.md)               | Install, define a table, build → compile → decode                                   |
| [Tables and column types](./tables-and-types.md)      | `table()`, column options, external tables, the column-type constructors            |
| [Building queries](./queries.md)                      | `select`, `where`, `groupBy`, `orderBy`, `limit`, `format`, immutability            |
| [Expressions and conditions](./expressions.md)        | Comparisons, arithmetic, optional predicates, aggregates                            |
| [Joins and subqueries](./joins-and-subqueries.md)     | The join family, `fromQuery`, correlated subqueries                                 |
| [Unions and CTEs](./unions-and-ctes.md)               | `unionAll`, `fromUnion`, `withCTE`                                                  |
| [Inserting rows](./inserts.md)                        | `insertInto`, the insert row type, `DEFAULT`, binding                               |
| [Updating and deleting](./updates-and-deletes.md)     | `update`, `deleteFrom`, `allRows`, ClickHouse mutations                             |
| [Params and compilation](./params-and-compilation.md) | `param.*`, how values reach the SQL, `CompiledQuery`                                |
| [Decoding results](./decoding-results.md)             | `rowSchema`, `decodeRows`, `decodeFirstRow`, decode errors                          |
| [Running a query](./running-queries.md)               | Executing the SQL with a real client, wire settings, `SETTINGS`                     |
| [Benchmarking](./benchmarking.md)                     | Define suites, measure baseline/candidate runs, verify results, and compare budgets |
| [Agent benchmark playbook](./benchmark-agent.md)      | Repeatable optimization workflow and evidence checklist                             |
| [Tenant scoping](./tenant-scoping.md)                 | `tenantScope`, what marks a query scoped, `crossTenant()`                           |
| [Extending the DSL](./extending.md)                   | `defineFn`, raw escape hatches, handwritten SQL                                     |
| [Postgres](./postgres.md)                             | The Postgres dialect, its column types and functions                                |
| [Schema and migrations](./migrations.md)              | DDL from `CH.table` / `PG.table`, `materializedView`, `effect-orm generate`, applying migrations, adopting drizzle-kit |
| [Statements and transactions](./database.md)          | `Database` over your `SqlClient`: `run`, `execute`, `transaction`, retry            |

## Reference

- [Recipes](./recipes.md) — complete examples for everyday queries.
- [Troubleshooting](./troubleshooting.md) — common failures and sharp edges.

- [API reference](./reference.md) — the full export catalog by module, plus error types.

## Entry points

| Import                                        | Contents                                                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@maple-dev/effect-orm/clickhouse`            | Everything for ClickHouse: the query builder (`from`, `param`, `insertInto`, `compile`, …), column types (`string`, `uint64`, `map`, …), ClickHouse functions under friendly names (`min`, `max`, `count`, `quantile`, …), and `table`, `column`, `engine`, `index`, `materializedView` |
| `@maple-dev/effect-orm/postgres`              | Everything for Postgres: the same builder, Postgres column types (`text`, `int8`, `timestamptz`, `jsonb`, …) and functions, `table`, `column`, `index`, `uniqueIndex`, `foreignKey`, and a `compile` for Postgres |
| `@maple-dev/effect-orm/expr`                  | Kitchen-sink namespace: every expression helper plus all ClickHouse functions under their raw names (`min_`, `toString_`, `dynamicColumn`, `not`, …)      |
| `@maple-dev/effect-orm/sql`                   | The low-level `SqlFragment` AST (`raw`, `ident`, `compile`, …) for hand-rolling fragments                                                                 |
| `@maple-dev/effect-orm/benchmark`             | Driver-free suite definitions, runner, report schemas, and comparisons                                                                                    |
| `@maple-dev/effect-orm/benchmark/http`        | ClickHouse HTTP transport, environment configuration, and query-log collection                                                                            |
| `@maple-dev/effect-orm/benchmark/cli`         | `runCli(args)` for embedding the bundled `ch-bench` commands                                                                                              |
| `@maple-dev/effect-orm/schema`                | Tooling over `table` values: `renderSchema` / `renderPgSchema`, `entitiesOf` / `pgEntitiesOf`, snapshots, and the schema diff. Pure                       |
| `@maple-dev/effect-orm/kit`                   | `generate` and `check` over a migrations folder, `defineConfig`, and `runCli` for the bundled `effect-orm` command. Node or Bun                          |
| `@maple-dev/effect-orm/migrate`               | `run`, `status`, `verify`, `baseline`, and `MigrationDriver`: applies ClickHouse or Postgres migrations through a driver you provide                     |
| `@maple-dev/effect-orm/database`              | `Database` over your `SqlClient`: `run` compiled queries, `execute` statements, `transaction` with settings and contention retry                           |

There is no root import: pick the dialect entry. [The reference](./reference.md) lists every
export of both.

## Query benchmarks

The optional `@maple-dev/effect-orm/benchmark` entry point and bundled
`ch-bench` CLI measure real queries, compare fixed workloads, and save evidence.
See [Benchmarking](./benchmarking.md) and the
[agent playbook](./benchmark-agent.md). The SQL builders remain driver-free.

# Schema and migrations

Every table is declared with its DDL: `table` from `/clickhouse` or `/postgres` carries the
engine, keys, indexes, and defaults beside the columns the query builder reads. You can ignore
that and manage the database elsewhere, or let three opt-in entry points turn the definitions
into migrations:

| Entry                              | Runs where         | What it does                                                                  |
| ---------------------------------- | ------------------ | ----------------------------------------------------------------------------- |
| `@maple-dev/effect-orm/schema`     | anywhere, pure     | reads `table` / `materializedView` values: DDL rendering, snapshots, the diff |
| `@maple-dev/effect-orm/kit`        | Node or Bun        | `generate` and `check` over a migrations folder; the `effect-orm` command     |
| `@maple-dev/effect-orm/migrate`    | anywhere Effect runs | applies migrations through a driver you provide, `status`, `verify`        |

Both ClickHouse and Postgres. The model follows drizzle-kit (a committed snapshot per migration,
an offline `generate`, data-loss confirmations by prompt or by hints). Snapshots, the branch
check and folder loading are shared; table definitions, the diff, the DDL, the runtime and
drift detection are per database, because the two differ where it matters: ClickHouse DDL is
not transactional and cannot change most things in place, and Postgres DDL is and can. The
sections below describe ClickHouse first; [Postgres](#postgres) covers what differs.

## Defining tables

`CH.table` returns a `Table`, so every query API accepts it. Columns are the usual column
types, or `CH.column(type, options)` for a default, a codec, or a comment. Keys, TTL, defaults,
and index expressions are SQL strings or DSL callbacks. `/schema` only reads these values: it
renders them, snapshots them, and diffs them.

```ts title="migrations-schema.ts"
import { Effect } from "effect"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import * as S from "@maple-dev/effect-orm/schema"

export const Requests = CH.table("requests", {
	columns: {
		OrgId: CH.custom("LowCardinality(String)", CH.string.schema),
		Timestamp: CH.dateTime,
		Route: CH.string,
		Status: CH.column(CH.uint16, { default: 200 }),
	},
	engine: CH.engine.mergeTree(),
	orderBy: ["OrgId", "Route", "Timestamp"],
	partitionBy: "toDate(Timestamp)",
	ttl: CH.ttlAfterDays("toDate(Timestamp)", 30),
	indexes: [CH.index("idx_status", ($) => $.Status, "set(100)")],
	tenantColumn: "OrgId",
})

export const RoutesHourly = CH.table("routes_hourly", {
	columns: { OrgId: CH.string, Hour: CH.dateTime, Route: CH.string, Requests: CH.uint64 },
	engine: CH.engine.summingMergeTree(),
	orderBy: ["OrgId", "Hour", "Route"],
})

// The body is a DSL query. An output column the target lacks, or of another
// type, is a type error here rather than a failed insert later.
export const RoutesHourlyMv = CH.materializedView("routes_hourly_mv", {
	to: RoutesHourly,
	as: CH.from(Requests)
		.select(($) => ({ OrgId: $.OrgId, Hour: CH.toStartOfHour($.Timestamp), Route: $.Route, Requests: CH.count() }))
		.groupBy("OrgId", "Hour", "Route"),
})

export const ddl = Effect.map(S.entitiesOf([Requests, RoutesHourly, RoutesHourlyMv]), (entities) => S.renderSchema(entities))
```

A definition that cannot become DDL (a MergeTree without `orderBy`, a name that is not a plain
identifier, a view writing to a table outside the schema) never throws: it records the problem
on its `problems`, and `S.entitiesOf` fails with a `SchemaDefinitionError` listing every
problem in the schema. `CH.dateTime64` renders as `DateTime64`, which ClickHouse reads as
`DateTime64(3)`; declare another precision with `CH.custom`.

Write engines as the plain family. Replicated engines and `ON CLUSTER` are render options
(`{ replicated: {}, cluster: "main" }`), so one schema serves a single server, a cluster, and
ClickHouse Cloud.

A table declared with `external: true` (a system table, a table function, a table another tool
migrates) carries no DDL: `S.isSchemaObject` is false for it, so `generate` skips it and
`entitiesOf` does not take it. See
[External tables](./tables-and-types.md#external-tables).

## Generating migrations

Create `effect-orm.config.ts`:

```ts
import { defineConfig } from "@maple-dev/effect-orm/kit"

export default defineConfig({
	schema: "./src/schema.ts",
	out: "./migrations",
})
```

Then `effect-orm generate --name add_status` (with Bun, or Node with type stripping) imports the
schema modules, diffs them against the newest snapshot in `out`, and writes
`migrations/<YYYYMMDDHHMMSS>_add_status/` holding `migration.json` and `snapshot.json`. It never
connects to a database. The plan it prints labels each statement:

- `metadata`: a schema change with no data rewrite.
- `ingest gap`: a materialized view is dropped and recreated. Inserts in between are not
  materialized by it. A view's body is fixed at creation, so this is the only way to change one.
- `destructive`: a table or column is dropped.
- `backfill`: rows are copied into a table (see [Backfills](#backfills)). Never generated.

Drops need confirmation. In a terminal, `generate` asks. Without one, it exits with status 2,
writes nothing, and prints the hints to pass back:

```sh
effect-orm generate --hints '[{"type":"confirm_data_loss","kind":"column","entity":"requests.Route"}]'
```

Changes ClickHouse cannot make with `ALTER` (engine, sorting key, partition key, primary key,
column type) are reported and nothing is written. They need a table rebuild, which `generate`
does not write yet. Renames are not detected yet either: a rename reads as a drop plus an add,
and the drop asks for confirmation, so it never loses data silently.

`effect-orm generate --custom` writes an empty `migration.sql` for statements you write by hand
(separate them with a line holding `--> statement-breakpoint`). Its snapshot copies its parent's.

### Backfills

A table or view created with history to fill needs an `INSERT ... SELECT`, which `generate` cannot
infer. Add a `backfill` op by hand to the generated `migration.json`, after the ops it depends on:

```json
{
	"op": "backfill",
	"backfill": {
		"target": "totals",
		"columns": ["OrgId", "Name", "Count"],
		"from": "events",
		"timeColumn": "Timestamp",
		"select": "OrgId, Name, sum(Count)",
		"groupBy": "OrgId, Name",
		"windowDays": 1
	}
}
```

It runs as one statement per window of `windowDays` (default 1) on `timeColumn`, over the
source's `min` to `max` when the migration runs. Windows are aligned to the epoch, not to the
data, and each is journaled under its start date (`0.2026-10-01`). A resumed run skips the
windows it finished, even after TTL has moved the lower bound, and adds any the source has
grown into. Each window compares the raw column (`prefer_column_name_to_alias = 1`), so a
`select` aliasing `Timestamp` to itself still prunes partitions. With `groupBy`, use windows at
least as coarse as the grain, so no group is split across two windows.

`effect-orm check` validates the folder: every snapshot id matches its contents, every parent
exists and sorts earlier, and branches merged from different pull requests touch different
tables. Independent branches are fine: the next `generate` records both as parents. Branches that
change the same table conflict; delete one migration and generate it again on top of the other.
Run `check` in CI.

### Starting from an existing database

A ClickHouse database that predates effect-orm does not need its tables written by hand.
`effect-orm pull` reads the database the config's `driver` connects to and writes a schema
module, one `CH.table` per table; then `generate --baseline` starts the history from it:

```sh
effect-orm pull                         # writes the config's schema module; --out <path> for another
effect-orm generate --baseline          # a migration that runs nothing, with this schema as its snapshot
effect-orm migrate                      # runs no statement; records the baseline as applied
```

The module is written so that its definitions yield exactly what the database holds: engine
and its arguments, keys as declared, partition key, TTL, settings, comments, column defaults
(`DEFAULT`, `MATERIALIZED`, `ALIAS`), codecs and skipping indexes, with every expression as the
server's own text. The first `generate` after the baseline finds nothing to do. A `Replicated`
or `Shared` engine is written as its plain family; replication is a render option.

Column types map to the built-ins that write the same SQL (`LowCardinality(Nullable(String))` is
`CH.lowCardinality(CH.nullable(CH.string))`). A type without one becomes `CH.custom` with the
schema its JSON value decodes with (`UUID` and `Date` as strings, `Decimal` and `Int8` as
numbers, an `Enum8` as its labels), and a type the generator does not know (`Tuple`, `JSON`, a
`Map` keyed by numbers) becomes `CH.untyped`. The file's header lists what to review:

- **Materialized views** are not generated: a view's body is a query-DSL value, which SQL text
  cannot be turned back into. The header quotes each body; write it with `CH.materializedView`.
- **Views, dictionaries, `Distributed`, `Kafka` and other non-MergeTree tables** are written as
  `external: true`: queryable, never migrated.
- A table with a name that is not a plain identifier (`my-col`), or a MergeTree declared in the
  old `MergeTree(date, key, granularity)` syntax, is written as external too.
- **Not modeled, so left out:** `SAMPLE BY`, projections, constraints and `EPHEMERAL` columns.
  Column-level TTLs are not read at all.
- A `Decimal` wider than 15 digits decodes to a number, which rounds; the header flags each one.

`--tables a,b` writes only those tables; `--force` overwrites an existing file. `verify` reports
the views and materialized views as `unexpected` until the schema declares them. Postgres is
not supported yet.

## Applying migrations

The library opens no connection. Give it a `MigrationDriver`, usually built from the
`SqlClient` you query with. ClickHouse DDL has to go through the client's `asCommand`.

```ts title="migrations-run.ts"
import { ClickhouseClient } from "@effect/sql-clickhouse"
import { Effect, Layer } from "effect"
import * as Migrate from "@maple-dev/effect-orm/migrate"

const Driver = Layer.effect(
	Migrate.MigrationDriver,
	Effect.gen(function* () {
		const sql = yield* ClickhouseClient.ClickhouseClient
		return Migrate.fromSqlClient(sql, { command: sql.asCommand })
	}),
)

export const program = Effect.gen(function* () {
	const migrations = yield* Migrate.fromRecord({
		"20261003120000_init": {
			kind: "sql",
			migration: "CREATE TABLE IF NOT EXISTS t (x UInt8) ENGINE = MergeTree ORDER BY x",
		},
	})
	const applied = yield* Migrate.run({ migrations, strict: true })
	const { drift } = yield* Migrate.verify(migrations)
	return { applied, drift }
}).pipe(
	Effect.provide(Driver),
	Effect.provide(ClickhouseClient.layer({ url: "http://localhost:8123" })),
)
```

`Migrate.fromFileSystem(dir)` reads a migrations folder through Effect's `FileSystem`; add a
`driver` layer to the config and the CLI runs `effect-orm migrate`, `status`, and `verify`.

How a run behaves:

- **Order** follows the snapshots' parent links, then names.
- **Pending** means not in the ledger, by name. An applied migration's hash is checked; with
  `strict` a changed file fails with `MigrateHashMismatch`, otherwise it logs a warning.
- **Each statement is journaled** in `_effect_orm_migration_steps` after it finishes, and the
  migration row in `_effect_orm_migrations` is written last. A run that fails partway leaves
  the migration `partial`; the next run skips the finished statements and resumes. A finished
  statement whose SQL has since changed fails the run with `MigrateStepChanged` instead of being
  skipped: edit only the failed statement and those after it.
- **Uncertain statements are never repeated.** `started` is journaled before a statement runs. If
  the process dies, or the `done` row cannot be written, the statement may or may not have run, and
  the next run stops there with `MigrateStepUncertain` (status `uncertain`). Check the database,
  then record what happened: `Migrate.resolveStep` or `effect-orm resolve <migration> <step>
  --ran | --not-ran`. A statement the server rejected is journaled `failed` and simply runs again.
- **A lease** in `_effect_orm_migration_lease` stops a second run while one is active. It is best
  effort: two runs starting in the same instant can both proceed. Serialize deploys if that
  matters.
- **No rollback.** Write a new migration. Prefer expand, then contract: add the new shape, move
  readers, and drop the old shape in a later migration.

`Migrate.verify` compares the database with the snapshot of the **last applied** migration, so a
database that is behind is reported as behind (`status`), not as drifted. The server normalizes
both sides (`formatQuery`, `defaultValueOfTypeName`). It checks tables, engine family, keys,
columns, skipping indexes, and view targets and bodies; it does not check TTL, codecs, settings,
or comments yet. `effect-orm verify` exits 3 when it finds drift.

### Running one step at a time

`run` applies everything in one process. An orchestrator that runs each statement as its own
durable step (a workflow engine, a job queue) uses the parts `run` is built from:

```ts
const pending = yield* Migrate.pendingMigrations({ migrations, strict: true })
for (const migration of pending) {
	const plan = yield* Migrate.planMigration(migration) // reads backfill bounds; plain data
	for (const step of plan.steps) if (!step.done) yield* Migrate.applyStep(plan.name, step)
	yield* Migrate.completeMigration(migration)
}
```

Plan a migration only once the ones before it are applied: a backfill reads its source when it
is planned. These calls take no lease, so the orchestrator must run one migration at a time.

_(Effect's own `ClickhouseMigrator` creates its ledger with a statement ClickHouse 26.8
rejects, and inserts ledger rows before running each migration. That is why this package has
its own runner.)_

## Postgres

Set `dialect: "postgres"` in the config and define tables with `PG.table`. `generate`, `check`,
`migrate`, `status` and `verify` then work as above, with the differences below.

```ts title="migrations-postgres.ts"
import { Effect } from "effect"
import * as PG from "@maple-dev/effect-orm/postgres"
import * as S from "@maple-dev/effect-orm/schema"

export const Dashboards = PG.table("dashboards", {
	columns: {
		org_id: PG.text,
		id: PG.text,
		status: PG.column(PG.text, { default: "open" }),
		created_at: PG.column(PG.timestamptz, { defaultExpr: "now()" }),
		archived_at: PG.nullable(PG.timestamptz),
	},
	primaryKey: ["org_id", "id"],
	indexes: [PG.index("dashboards_open_idx", ["org_id"], { where: ($) => $.archived_at.isNull() })],
	tenantColumn: "org_id",
})

export const Shares = PG.table("dashboard_shares", {
	columns: { org_id: PG.text, id: PG.text, dashboard_id: PG.text, widget_id: PG.nullable(PG.text), revoked_at: PG.nullable(PG.timestamptz) },
	primaryKey: ["org_id", "id"],
	indexes: [
		// At most one live share per dashboard and widget: a partial unique index on an expression.
		PG.uniqueIndex("dashboard_shares_live_unq", ($) => [$.org_id, $.dashboard_id, PG.coalesce($.widget_id, PG.lit(""))], {
			where: "revoked_at is null",
		}),
	],
	foreignKeys: [
		PG.foreignKey({ columns: ["org_id", "dashboard_id"], references: Dashboards, foreignColumns: ["org_id", "id"], onDelete: "cascade" }),
	],
})

export const ddl = Effect.map(S.pgEntitiesOf([Dashboards, Shares]), (entities) => S.renderPgSchema(entities))
```

**Definitions.** A column is `NOT NULL` unless its type is `PG.nullable(...)`. `PG.column(type,
options)` adds a `default` (a value of the column's type), a `defaultExpr` (SQL or a DSL
expression) or an `identity` (`"always"` or `"by default"`); any of them makes the column
optional on insert. `primaryKey` takes column names, or `{ columns, name }`; the default name is
`<table>_pkey`. Indexes are `PG.index` / `PG.uniqueIndex` over column names or expressions,
with `where` for a partial index and `using` for the access method. A foreign key without a
`name` gets drizzle-orm's, `<table>_<columns>_<foreign table>_<foreign columns>_fk`, shortened
with drizzle-kit's hash to `<table>_<hash>_fk` when it would pass 63 characters. Types are
stored as Postgres names them (`int4` is `integer`), so snapshots compare with the catalog and
with drizzle-kit.

**Unique constraints.** `uniqueConstraints: [PG.unique(name, columns, { nullsNotDistinct? })]`
on a table, or `unique` in `PG.column` for one column, declares a `UNIQUE` constraint: `ALTER
TABLE ... ADD CONSTRAINT name UNIQUE (columns)`, which is what drizzle-kit writes for `unique()`
and `.unique()`. It is not a unique index: Postgres backs it with an index of the same name, but
drops it with `DROP CONSTRAINT`, and a foreign key may reference its columns. `unique: true`
names the constraint `<table>_<column>_unique`, drizzle-orm's name; `unique: "name"` or `unique:
{ name, nullsNotDistinct }` gives another (drizzle-kit v1 names a column's unnamed `.unique()`
`<table>_<column>_key`, so say so when adopting one). `nullsNotDistinct` needs Postgres 15.
`onConflictDoNothing` / `onConflictDoUpdate` take the constraint's columns as `target`, or `{
constraint: name }`.

**Enums.** `PG.enumType(name, labels)` is a column type and a schema object; see
[Enums](./postgres.md#enums). Its `CREATE TYPE` comes before every table, and is skipped when
the type already exists (Postgres has no `IF NOT EXISTS` for it), so an enum created by hand
behind `PG.custom` can be declared with `enumType` later.

Check constraints, generated columns, views, sequences and tables in other schemas are not
modeled yet; write them in a `--custom` migration, and declare a view you query as an
[external table](./tables-and-types.md#external-tables).

**Generating.** Postgres changes a column's type, nullability, default or identity in place
(`ALTER COLUMN`), and a primary key, an index, a unique constraint or a foreign key by dropping
and re-creating it. A type change is labeled `rewrite`: Postgres rewrites the table under an
exclusive lock. Drops need confirmation, dropping an enum type included (`"kind": "enum"`), and
renames of tables and columns still read as a drop and an add. Enum types are created first and
dropped last, unique constraints are added before the foreign keys that reference them, and
turning a `uniqueIndex` into a `unique` of the same name drops the index before adding the
constraint. Generated files carry `"dialect": "postgres"`. With `emit: "sql"` in the config,
`generate` writes the rendered statements to `migration.sql` instead, each under a comment
naming its label, so a tool that applies drizzle-kit folders applies the migration too.

Enum labels change as far as Postgres can change them in place:

- **A new label** is `ALTER TYPE ... ADD VALUE`, with `BEFORE` the label it precedes, so the
  order matches the definition.
- **A renamed label**, the same labels in the same order but one replaced in place, is `ALTER
  TYPE ... RENAME VALUE`. Rows holding the old label then hold the new one, so it asks for a
  hint first: `{"type":"confirm_rename","kind":"enum_value","entity":"channel_type.direct","to":"dm"}`.
- **Removing or reordering labels** needs a new type and every column moved to it. `generate`
  reports it as unsupported and writes nothing; write that rebuild with `--custom`.

A migration is one transaction, and Postgres does not let a transaction use a label it added
(`unsafe use of new value`). So `generate` refuses a migration that adds a label and also
uses it, in a default or a partial index's predicate: add the label, generate, then use it and
generate again. Before Postgres 12, `ADD VALUE` cannot run in a transaction at all, so a
migration that adds a label needs Postgres 12 or later.

Moving an enum from `PG.custom("public.channel_type", ...)` to `PG.enumType("channel_type",
...)` generates a `create_enum`, skipped since the type exists, and an `alter_column` per column
from `public.channel_type` to `channel_type`, the same type under its unqualified name, which
leaves the data as it is.

**Applying.** Each migration runs in one transaction with its ledger row, under a
transaction-scoped advisory lock, so concurrent deploys wait for each other rather than
racing. A failed statement rolls the whole migration back and the next run starts it from the
top: there is no step journal, no lease, no `partial` or `uncertain` state, and nothing for
`resolve` to do. The driver needs a transaction, which `Migrate.fromSqlClient` provides from
`SqlClient.withTransaction`. A statement Postgres refuses inside a transaction (`CREATE INDEX
CONCURRENTLY`, `ALTER TYPE ... ADD VALUE` before Postgres 12) cannot be in a migration yet.

**Drift.** `verify` builds the expected schema in a scratch schema, inside a transaction it
always rolls back, and reads both catalogs with the same queries, so Postgres deparses both
sides and `'open'` matches the stored `'open'::text`. The scratch schema is searched before the
current one, so a type of the current schema resolves in both, and a column of it reads
`channel_type`, its default `'public'::channel_type`, on both sides, however the definition
qualified it. It checks enum types (labels, in order, read from `pg_enum`), tables, columns
(type, `NOT NULL`, default, identity), primary keys, unique constraints (columns, `NULLS NOT
DISTINCT`), indexes (uniqueness, method, keys, predicate) and foreign keys in the current
schema. A unique constraint is never read as an index, nor an index as a constraint. An enum
the snapshot does not declare is reported only if no column uses it, so a `PG.custom` enum still
verifies. `Migrate.verify(migrations, { ignoreTables })` skips tables another tool owns.

### Adopting a drizzle-kit folder

A drizzle-kit (v1) folder already has the layout `migrate` reads: `<timestamp>_<name>/migration.sql`
split on `--> statement-breakpoint`. Its `snapshot.json` files are recognized as drizzle-kit's
and set aside, so the folder runs as it is. Adoption is two steps:

1. `effect-orm generate --baseline --from-drizzle` writes a migration that runs nothing, whose
   snapshot is drizzle-kit's last one converted to entities: enums, tables, columns (enum columns
   included), keys, indexes, unique constraints and foreign keys. Anything the conversion cannot
   model (sequences, views, check constraints, policies, tables in other schemas) is listed and
   nothing is written. Without `--from-drizzle` the snapshot comes from your
   `PG.table` definitions instead. Migrations before the baseline are legacy: they run, but
   nothing diffs against them, and a plain `generate` refuses to run until a baseline exists.
2. On a database drizzle-kit (or anything else) already migrated, `effect-orm baseline <name>`
   (`Migrate.baseline`) records the baseline and every migration before it as applied, without
   running them. A fresh database, such as a test's, simply runs everything.

The first `generate` after the baseline diffs your `PG.table` definitions against what
drizzle-kit recorded, so every place they disagree (a constraint name, a default) shows up as an
op to accept or fix. `verify` against the baseline also finds objects the database has and
drizzle-kit's snapshot does not, such as a table a hand-written migration created and nothing
dropped.

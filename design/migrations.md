# Migrations: schema-as-code, snapshots, and a migrator

Status: phases 0 to 3 implemented on 2026-10-03 (branch `feat/migrations`); phase 6 (Postgres)
on 2026-10-04, see section 8; phases 4, 5 and 7 open.
Section 7 lists what was built and where it departs from this plan. User docs:
[`docs/migrations.md`](../docs/migrations.md).

Today `@maple-dev/effect-orm` models tables for **querying**: `table(name, columns)` is a name and a
column record, `docs/tables-and-types.md` calls it "a contract you keep in sync with your
migrations", and the package never touches the network. This doc studies how Drizzle does
migrations (drizzle-orm and drizzle-kit `1.0.0-rc.5-5935859`, read from source), notes Effect's
own `effect/sql/Migrator` (effect `4.0.0`), and proposes how effect-orm can own the schema too.

**In one paragraph.** Add an opt-in DDL layer (`defineTable`, `materializedView`) whose values are
still ordinary `Table`s, so nothing about querying changes. Copy Drizzle's authoring model almost
whole: an offline `generate` that diffs a committed per-migration snapshot against the code,
rename resolution by prompt or hints, `check` for branch conflicts. Do **not** copy its runtime for
ClickHouse: no transactions, apply-by-name without hash checks, and "all pending in one batch" are
wrong there. Ship a migrator that runs on Effect's `SqlClient` (already part of the `effect` peer
dependency), journals per statement, verifies hashes, and has first-class ClickHouse operations
for what `ALTER` cannot do. ClickHouse first. Postgres second, because drizzle-kit already serves it.

---

## 1. How Drizzle does it (v1 RC)

### Schema to snapshot to SQL (`generate`)

1. The TypeScript schema is serialized (`fromDrizzleSchema`, then `interimToDDL`) into a **flat
   list of entities** tagged with `entityType` (`tables`, `columns`, `pks`, `fks`, `indexes`, ...).
2. The previous snapshot is the **last migration folder by name**. An empty folder diffs against a
   "dry" snapshot.
3. `ddlDiff` diffs one entity kind at a time (schemas, enums, tables, columns, indexes, pks, fks,
   views, ...). Renames resolved for a kind are applied to the old side before the next kind.
4. Every diff statement maps to exactly one convertor (`createTableConvertor`,
   `addColumnConvertor`, ...); an unmapped one throws `No convertor for`.
5. Output: `drizzle/<YYYYMMDDHHMMSS>_<name>/{migration.sql, snapshot.json}`, statements joined by
   `--> statement-breakpoint`. No changes writes nothing. **`generate` never connects to a database.**

```json
{ "id": "<uuid>", "prevIds": ["<parent uuid>"], "version": "8", "dialect": "postgres",
  "ddl": [{ "entityType": "tables", "name": "...", "schema": "public" }], "renames": [] }
```

### Ordering, identity, tracking table

- v1 has **no journal**. Order is lexical by folder name, so the timestamp prefix is the order.
- `prevIds` is an array, so a merge snapshot can have two parents.
- Runtime (`drizzle-orm/migrator.js`): one entry per folder, `hash = sha256(migration.sql)`, SQL
  split on the breakpoint.
- Table: `drizzle.__drizzle_migrations (id serial, hash text, created_at bigint, name text, applied_at timestamptz)`.
  A v0 table (`id, hash, created_at`) is upgraded in place and its rows matched back to folders.
- **What runs is decided by name only**: every local folder not in the table. A branch migration
  with an older timestamp still runs. **The stored hash is never checked again**, so editing an
  applied migration goes unnoticed.
- All pending migrations run in **one transaction**.

### Commands

| Command    | Behavior                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `generate` | Offline diff, writes a folder. `--custom` writes an empty SQL file with a snapshot copied from its parent, keeping the chain continuous. `--name` sets the slug. |
| `migrate`  | `check`, then the runtime migrator.                                                                                            |
| `push`     | Introspect the live DB, diff against the code, apply directly. No files, no history.                                           |
| `pull`     | Introspect into TypeScript plus a commented `migration.sql`. `--init` records it as applied (the baseline).                   |
| `check`    | Validate snapshot versions and detect conflicting branches.                                                                    |
| `up`       | Upgrade folder layout and snapshot versions.                                                                                   |
| `drop`     | Removed. Delete the folder by hand.                                                                                            |

### Renames and ambiguity

When one entity kind has both creates and deletes, a TTY gets a prompt: "Is X created or renamed
from another X?". Without a TTY drizzle-kit **does not guess**: the ambiguity becomes a missing
hint, nothing is written, and it exits 2. The caller retries with `--hints` or `--hints-file`
(`{type:"rename",kind,from,to}`, `{type:"create",...}`, `{type:"confirm_data_loss",...}`).
`--output json` makes it machine-readable, which is what makes it usable by agents and CI.

### Rollback and branches

- **No down migrations.** Rollback only happens when the transaction undoes a failed batch.
- `check` builds a parent-to-children graph from `prevIds`. Where a parent has several children it
  diffs each branch and intersects their footprints. Overlap is a `conflicts` error. Disjoint
  branches are "commutative", and the next `generate` writes a merge snapshot with both leaves as
  `prevIds`.
- A real hazard, seen in a consumer repo: two folders created in the same second
  (`20260706224607_electric_publication_wave1` and `20260706224607_huge_dexter_bennett`) apply in
  name order even though the first one's `prevIds` points at the second.

### The lesson

Drizzle's value is in **authoring**: a snapshot per migration turns "what changed" into a pure,
offline diff, and `check` turns branch conflicts into a CI failure. Its **runtime** is deliberately
thin because Postgres DDL is transactional. ClickHouse DDL is not, so the runtime is where
effect-orm has to do more than Drizzle, not less.

---

## 2. Effect's own `Migrator`, and why it is not enough for ClickHouse

`effect/sql/Migrator` (re-exported as `@effect/sql-clickhouse/ClickhouseMigrator`) is hand-written
migrations, not schema-as-code: a loader returns `[id, name, Effect]` triples (`fromGlob`,
`fromRecord`, `fromFileSystem`) and the runner tracks `effect_sql_migrations (migration_id, name, created_at)`.
Reading `node_modules/effect/src/sql/Migrator.ts`:

- It applies migrations with **`id > max(applied id)`**. A branch migration with a lower id that
  merges later is silently skipped. Drizzle's name set does not have this problem.
- It **inserts the ledger rows first**, then runs the migrations, all inside
  `sql.withTransaction`. The "lock" is a primary-key conflict on that insert.
- On ClickHouse, the client's `beginTransaction` is `BEGIN TRANSACTION` (experimental, MergeTree
  only, needs a session), primary keys are not unique, and the ledger table is created by the
  generic `orElse` branch. So the lock cannot work, and a migration that fails halfway is likely
  **already recorded as applied**. Confirm this on a live server (phase 0); if it holds, it is
  worth reporting upstream either way.
- No hashes, no snapshots, no diff.

What we keep from it: migrations as Effects that need `SqlClient`, the loader shapes, and the fact
that `SqlClient` lives in the `effect` package. That means a migrator can ship in effect-orm
**without a new dependency and without the library opening a connection itself**: the caller
provides a `SqlClient` layer (`@effect/sql-clickhouse`, `@effect/sql-pg`, ...), exactly as they do
for queries today.

---

## 3. What transfers, what does not

### Transfers from Drizzle

| Drizzle                                                   | effect-orm                                                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Schema in TypeScript is the only source of truth         | `defineTable` / `materializedView` values; still usable as `Table`s in queries               |
| Flat, entity-tagged snapshot JSON per migration           | Same idea, ClickHouse entity kinds (section 4.2)                                             |
| Offline `generate`, `--custom`, `--name`                  | Same                                                                                         |
| Kind-by-kind diff, renames applied before the next kind   | Same order, ClickHouse kinds                                                                  |
| TTY prompts; non-TTY hints, exit 2, `--output json`       | Same contract and hint shapes, so tooling written for drizzle-kit hints carries over          |
| Folder per migration, timestamp prefix, `prevIds` DAG     | Same layout; ordering fixed to follow the DAG (4.3)                                           |
| `check` with commutativity                                | Same, with footprints per ClickHouse object                                                   |
| `pull --init` baseline                                    | `pull` writes `defineTable` code from `system.*`; `--init` records the baseline              |
| `push` for development                                    | Same, refused unless `--dev` or a local URL                                                  |
| Name-based "what is pending"                              | Same, and **the hash is verified** (Drizzle stores it and never reads it)                     |

### Does not transfer to ClickHouse

- **Transactions.** There are none for DDL, and a migration can stop between statements. Instead:
  generated statements are idempotent (`IF [NOT] EXISTS`), each statement is journaled after it
  finishes, and a rerun resumes at the first unjournaled statement. The ledger row for the whole
  migration is written **last**, never first.
- **Arbitrary `ALTER`.** You cannot change an engine, `PARTITION BY`, or the primary key, and
  `MODIFY ORDER BY` can only append columns added in the same `ALTER`. These become a typed
  **rebuild**: create `<t>__new`, backfill in windows, `EXCHANGE TABLES` (Atomic database) or
  rename, recreate dependent views, drop the old table. The generator emits the rebuild op and
  refuses to emit an `ALTER` the server would reject.
- **Materialized views.** The SELECT is frozen at creation. A body change is `DROP VIEW` +
  `CREATE MATERIALIZED VIEW` (inserts in the gap are not materialized) or `ALTER TABLE <mv> MODIFY QUERY`
  where the server allows it. New views never use `POPULATE`; history comes from an explicit
  backfill ordered so it and the live view never write the same rows. Drops are ordered
  `DROP VIEW` before `DROP TABLE`; the inverse leaves a view pointing at a missing target and every
  insert into its source fails with `UNKNOWN_TABLE`.
- **Mutations.** `MODIFY COLUMN` type changes, `MATERIALIZE COLUMN`, `MATERIALIZE INDEX` and
  `ALTER ... UPDATE/DELETE` rewrite parts in the background. A step that starts one waits on
  `system.mutations` (or runs with `mutations_sync = 2`) before it is journaled, and the plan
  labels it "rewrites data".
- **TTL.** `MODIFY TTL` runs with `materialize_ttl_after_modify = 0` unless the migration opts in,
  so a TTL edit does not rewrite a large table by accident.
- **Backfills.** A single `INSERT ... SELECT` over a big table can outlast any HTTP timeout. A
  `backfill` op declares target, columns, source, time column and projection; the runner splits it
  into day-aligned windows and journals each window. Convergence on rerun is the author's job
  (truncate or rebuild the target first), and `check` lints for it.
- **Clusters.** Self-managed clusters may need `ON CLUSTER <name>` on every statement and
  `Replicated*` engines, while ClickHouse Cloud uses `SharedMergeTree` and needs neither. Engine
  flavor and cluster name are **render-time options**, not part of the schema, so one schema
  serves all three. The ledger must be replicated too, or replicas disagree about what ran.
- **Locking.** No advisory locks. The runner takes a lease row (owner, expiry) in the ledger and
  refuses to start while a live one exists. This is best effort and documented as such; callers
  that need a hard guarantee serialize runs themselves.
- **Rollback.** None, as in Drizzle. Dropped data does not come back. Document
  expand/contract: add in one release, stop reading the old shape, drop in a later one.
- **Server versions.** Some objects only exist on newer servers (text indexes, for example). A
  schema entry can declare `minServerVersion`. The migrator skips it with a recorded reason on older
  servers and installs it on the next run after an upgrade, without blocking the migrations that
  correctness depends on.

---

## 4. Design

### 4.1 Schema definition (`@maple-dev/effect-orm/schema`)

```ts
import * as S from "@maple-dev/effect-orm/schema"
import * as T from "@maple-dev/effect-orm/types"

export const Spans = S.defineTable("spans", {
	columns: {
		OrgId: S.column(T.custom("LowCardinality(String)", Schema.String)),
		Timestamp: S.column(T.dateTime64, { codec: "Delta, ZSTD(1)" }),
		ServiceName: S.column(T.string),
		Duration: S.column(T.uint64, { default: 0 }),
	},
	engine: S.engine.mergeTree(),
	orderBy: ["OrgId", "ServiceName", "Timestamp"],
	partitionBy: ($) => CH.toDate($.Timestamp),
	ttl: ($) => S.ttl.delete(CH.toDate($.Timestamp), { days: 30 }),
	indexes: [S.index.bloomFilter("idx_trace", ($) => $.TraceId, { granularity: 1 })],
	tenantColumn: "OrgId",
})

export const SpansHourly = S.materializedView("spans_hourly_mv", {
	to: SpansHourlyTarget,
	as: CH.from(Spans).select(($) => ({ OrgId: $.OrgId, Hour: CH.toStartOfHour($.Timestamp), Count: CH.count() })).groupBy("OrgId", "Hour"),
})
```

- `defineTable` returns a value that **is** a `Table` (`_tag: "Table"`, same `name`, `columns`
  readable as `ColumnDefs`, same `tenantColumn`), plus a `ddl` field. Every existing query API
  accepts it unchanged; `table()` stays as it is for people who manage DDL elsewhere.
- Expressions in `partitionBy`, `ttl`, defaults, and index expressions reuse the query DSL, so
  they are typechecked against the table's columns.
- A materialized view's body **is a query built with the DSL**, compiled with the ClickHouse
  dialect at snapshot time. Its output row is checked against the target table's columns at the
  type level, which catches the drift (a view writing a column the target lacks, or the wrong type)
  that today only surfaces as a failed insert.
- `T.custom`'s SQL name is the column type in DDL. No new type system.

### 4.2 Snapshot

```json
{
  "version": "1",
  "dialect": "clickhouse",
  "id": "<sha256 of normalized entities>",
  "prevIds": ["<parent id>"],
  "entities": [
    { "kind": "table", "name": "spans", "engine": { "family": "MergeTree", "params": [] },
      "orderBy": "OrgId, ServiceName, Timestamp", "partitionBy": "toDate(Timestamp)",
      "primaryKey": null, "ttl": "toDate(Timestamp) + toIntervalDay(30)", "settings": {} },
    { "kind": "column", "table": "spans", "name": "Duration", "position": 3, "type": "UInt64",
      "default": { "kind": "DEFAULT", "expr": "0" }, "codec": null, "comment": null },
    { "kind": "index", "table": "spans", "name": "idx_trace", "expr": "TraceId", "type": "bloom_filter", "granularity": 1 },
    { "kind": "materialized_view", "name": "spans_hourly_mv", "to": "spans_hourly",
      "sources": ["spans"], "select": "<formatted SELECT>" }
  ],
  "renames": []
}
```

- Flat, sorted, deterministic, like Drizzle's `ddl`.
- `id` is a **content hash**, not a random UUID: two branches that reach the same schema agree, and
  `check` can recompute every id.
- SQL fragments (expressions, MV bodies) are stored in the server's canonical form. `generate`
  stays offline, so canonicalization is the library's own printer; `verify` compares against the
  live server with `formatQuery()` applied to both sides, so whitespace and quoting never show up
  as drift.
- Postgres snapshots use the same envelope with Postgres kinds (`table`, `column`, `pk`, `fk`,
  `unique`, `check`, `index`, `view`, `enum`).

### 4.3 Migration folder and ordering

```
migrations/
  20261003120000_init/
    snapshot.json
    migration.sql        # generated; breakpoint-separated
  20261005093000_add_service_version/
    snapshot.json
    migration.sql
  20261007150000_backfill_hourly/
    snapshot.json        # copied from parent (custom)
    migration.ts         # default export: a Plan of ops, or an Effect needing SqlClient
```

- Same layout as Drizzle v1, so people know it on sight.
- `migration.sql` covers plain DDL. `migration.ts` is for ops SQL cannot express (backfill
  windows, rebuilds, waits on mutations) and for arbitrary Effects (Effect `Migrator` style). The
  generator writes `.ts` automatically when a change needs a rebuild or backfill.
- **Order follows the `prevIds` DAG** (topological, folder name breaks ties between independent
  branches). `check` fails when names and the DAG disagree, which turns the same-second hazard
  into an error.
- Pending is decided **by name** (Drizzle), never by "greater than the last id" (Effect).

### 4.4 Generator

`effect-orm generate [--name x] [--custom] [--hints ...] [--output json]`:

1. Load the config (`effect-orm.config.ts`: `dialect`, `schema` glob, `out`, render options).
2. Import the schema modules, collect `defineTable` and `materializedView` values, build the
   snapshot. Offline.
3. Run `check`; diff against the DAG leaf (or the common ancestor with merged branch statements
   replayed, as drizzle-kit does).
4. Diff kind by kind: tables, columns, indexes, settings, TTL, keys, then views. Resolve renames
   before moving to the next kind.
5. Classify each change:

| Change                                           | Emitted                                                                         | Plan label          |
| ------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------- |
| New table / view                                 | `CREATE ... IF NOT EXISTS`, views without `POPULATE`                            | metadata            |
| Add column                                       | `ADD COLUMN IF NOT EXISTS ... AFTER ...`, then recreate views that should write it | metadata         |
| Default, comment, codec                          | `MODIFY COLUMN` (codec affects new parts only)                                  | metadata            |
| Column type                                      | `MODIFY COLUMN` + mutation wait; lossy casts need a hint                        | rewrites data       |
| Skip index                                       | `ADD/DROP INDEX IF [NOT] EXISTS`; `MATERIALIZE INDEX` only when asked           | metadata / rewrite  |
| TTL                                              | `MODIFY TTL` with `materialize_ttl_after_modify = 0`                            | metadata            |
| `ORDER BY` append of a column added in this change | one `ALTER` with `ADD COLUMN` and `MODIFY ORDER BY`                           | metadata            |
| Engine, `PARTITION BY`, primary key, other key change | `rebuild` op in `migration.ts`, backfill projection derived from the column mapping | rebuild    |
| View body                                        | `DROP VIEW` + `CREATE MATERIALIZED VIEW` (`MODIFY QUERY` behind an option)       | metadata, ingest gap |
| Drop column / table / view                       | dependents first, `DROP VIEW` before `DROP TABLE`; needs `confirm_data_loss`    | destructive         |
| Rename table / column                            | `RENAME TABLE` / `RENAME COLUMN IF EXISTS`, then recreate views that read it    | metadata            |

6. Write the folder and print the plan grouped by label, so "rewrites data", "ingest gap" and
   "destructive" lines stand out.

### 4.5 Runtime (`@maple-dev/effect-orm/migrate`)

```ts
const applied = yield* Migrate.run({
	loader: Migrate.fromFileSystem("./migrations"),   // or fromRecord(import.meta.glob(...)) for bundlers
	dialect: "clickhouse",
	render: { engineFlavor: "Replicated", cluster: "main" },
	strict: true,
})  // Effect<ReadonlyArray<AppliedMigration>, MigrateError, SqlClient>
```

Ledger, ClickHouse:

```sql
CREATE TABLE IF NOT EXISTS _effect_orm_migrations (
  name String, hash String, prev_ids Array(String),
  applied_at DateTime64(3) DEFAULT now64(3), status LowCardinality(String)
) ENGINE = ReplacingMergeTree(applied_at) ORDER BY name;

CREATE TABLE IF NOT EXISTS _effect_orm_migration_steps (
  name String, step String, sql_hash String, finished_at DateTime64(3) DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(finished_at) ORDER BY (name, step);
```

- A step is journaled only after it, and any mutation it started, has finished. The migration
  row is written last. A rerun skips journaled steps.
- `hash` is sha256 of the rendered migration. With `strict`, an applied migration whose hash
  differs is a `MigrateHashMismatch` error; otherwise it is a warning.
- Postgres: one transaction per migration, `pg_advisory_xact_lock` instead of `LOCK TABLE`, the
  same ledger columns in a `effect_orm` schema, and an importer for an existing
  `__drizzle_migrations` / `effect_sql_migrations` table so adopters keep their history.
- Errors are `Schema.TaggedError`s with namespaced tags (`MigrateLeaseHeld`, `MigrateHashMismatch`,
  `MigrateStepFailed` with a `Schema.Defect` cause, `MigrateUnsupportedChange`), consistent with
  how the package already reports `InvalidLiteral`. No throws.
- Each migration and step gets a span (`effect_orm.migration.name`, `effect_orm.migration.step`),
  following the `Migrator ${id}_${name}` precedent.
- `Migrate.layer(options)` mirrors `ClickhouseMigrator.layer` for "migrate on startup".

`Migrate.verify` introspects (`system.tables`, `system.columns`, `system.data_skipping_indices`,
`create_table_query` through `formatQuery()`) and diffs the live schema against the snapshot **of
the last applied migration**, not the code's HEAD. That reports drift and partial applies honestly.

### 4.6 CLI

One bin, `effect-orm` (next to `ch-bench`):

| Command                  | Needs a server | Notes                                                       |
| ------------------------ | -------------- | ----------------------------------------------------------- |
| `generate`               | no             | 4.4                                                         |
| `check`                  | no             | DAG validity, recomputed ids, name/DAG order, commutativity, backfill convergence lint, shipped-migration immutability against a git base (`--base origin/main`) |
| `migrate`                | yes            | Runs `Migrate.run` with a `SqlClient` layer exported from the config file |
| `status` / `plan`        | yes            | Pending migrations and their rendered steps, no execution  |
| `verify`                 | yes            | 4.5                                                         |
| `push`                   | yes            | Dev only: introspect, diff, apply, no files                |
| `pull [--init]`          | yes            | Introspect into `defineTable` source; `--init` baselines   |

The config file exports the `SqlClient` layer, so the package never imports a driver:

```ts
export default defineConfig({
	dialect: "clickhouse",
	schema: "./src/schema/*.ts",
	out: "./migrations",
	client: ClickhouseClient.layerConfig({ url: Config.String("CLICKHOUSE_URL") }),
})
```

### 4.7 Packaging

- Subpaths in the existing package: `./schema` (pure, browser-safe), `./migrate` (runtime,
  Effect only), `./kit` (generator, diff, node `fs`), plus the bin. `./benchmark/cli` already sets
  the precedent for node-only subpaths.
- No new runtime dependencies. Prompts use `node:readline`.
- The root barrel does not re-export `./kit` or `./migrate`, so query-only consumers pay nothing.
- `scripts/check-exports-documented.mjs` will demand docs for every new export. Keep the public
  surface small: the doc pages are part of the work, not an afterthought.

---

## 5. Phases

0. **Validate assumptions.** Live-ClickHouse tests (the `test:release` matrix) for: Effect
   `Migrator` behavior on a failing ClickHouse migration; `formatQuery()` round-trips of MV bodies
   on the oldest supported server; `EXCHANGE TABLES` and `MODIFY QUERY` availability per version.
1. **Schema layer.** `./schema` with `defineTable` and `materializedView`, DDL rendering, engine
   flavor and cluster options. Tests: rendered DDL is accepted by every matrix server, a
   `defineTable` value compiles through every existing query path, a view's type-level check
   rejects a mismatched target.
2. **Snapshot and offline generate (additive only).** Create table and view, add column, add
   index, TTL, defaults. `check` with DAG ordering. Snapshot tests.
3. **Migrator.** Ledger, step journal, lease, hashes, `status`, `plan`, `migrate`, `verify`.
   Live tests: kill between steps and resume, rerun is a no-op, hash mismatch fails under strict,
   a replicated ledger under `ON CLUSTER` (matrix permitting).
4. **The hard ClickHouse changes.** Renames with hints, view recreation, type changes with
   mutation waits, `rebuild`, windowed `backfill`, drops with dependency ordering, server-version
   gated entities.
5. **`pull`, `push`, `--init`.** Introspection back into TypeScript; baseline adoption.
6. **Postgres.** Same envelope, transactional runtime, importers for drizzle and Effect ledgers.
   Possibly only `migrate`/`verify` at first, if consumers keep drizzle-kit for authoring.
7. **First real consumer.** Maple's warehouse is the obvious one; it defines its schema with
   another tool today, so adoption needs either an adapter or moving its definitions to
   `defineTable`. That is Maple's decision and out of scope here, but its history is a useful
   requirements check: chunked backfills, view-before-table drops, view bodies frozen per version,
   and performance-only objects that must not block correctness.

---

## 6. Open questions

1. **Postgres scope.** Full parity with drizzle-kit, or ClickHouse-only authoring plus a runtime
   that can also apply drizzle-kit folders? The second is much less work and avoids competing with
   the tool people already use for Postgres.
2. **Packaging.** Subpaths of `@maple-dev/effect-orm` (proposed) or a separate
   `effect-orm-kit` like drizzle-kit, which keeps the main package's install small. The repo has one
   package today.
3. **`defineTable` vs extending `table()`.** A separate constructor keeps `table()` untouched; an
   options argument on `table()` is less API. Proposed: separate, because a DDL table needs engine
   and keys that a query-only table should not be forced to declare.
4. **Timestamps vs integers.** Proposed: Drizzle's timestamp names plus the `prevIds` DAG. Integer
   ids are friendlier for "schema version N" gates in consumers; the runner can expose an ordinal
   for that purpose either way.
5. **Canonical SQL offline.** `generate` cannot ask a server for `formatQuery()`. Is our printer
   close enough that drift only matters in `verify`, or should `generate` optionally use a local
   server or chDB?
6. **MV changes.** `DROP` + `CREATE` loses inserts during the gap; `MODIFY QUERY` has version and
   setting constraints. Which is the default?
7. **Lease semantics** on ClickHouse without a coordinator: is best effort acceptable, or should
   `ON CLUSTER` deployments require a Keeper-backed lock?
8. **Upstream.** Report the Effect `Migrator` ClickHouse behavior from phase 0 to Effect, and
   whether `migrate` should be offered back as a ClickHouse-aware `ClickhouseMigrator`.

---

## 7. Implementation notes (phases 0 to 3)

**Phase 0 findings.**

- Effect's `ClickhouseMigrator` (`@effect/sql-clickhouse` 4.0.0) fails on ClickHouse 26.8 before
  running any migration: its generic ledger `CREATE TABLE` is a syntax error there. Worse than
  section 2 assumed, and worth reporting upstream.
- `formatQuery` normalizes what `verify` needs (`INTERVAL 30 DAY` becomes `toIntervalDay(30)`),
  and `defaultValueOfTypeName` normalizes types (`DateTime64` becomes `DateTime64(3)`). The
  server rewrites codecs (`Delta` becomes `Delta(8)`), so codecs are not compared yet.
- `as_select` qualifies tables with the database name; `verify` strips it before comparing.
- `ALTER ... MODIFY TTL ... SETTINGS materialize_ttl_after_modify = 0`, `RESET SETTING`,
  `REMOVE DEFAULT`, `REMOVE CODEC`, and `DROP COLUMN ... SETTINGS mutations_sync = 2` all work
  on 26.2 and 26.8.

**Departures from the plan.**

- Generated migrations are `migration.json` (typed ops), not `migration.sql`. Ops render when
  they run, so `ON CLUSTER` and `Replicated*` engines come from the deployment, not from the
  committed file. Hand-written migrations (`--custom`) are `migration.sql` with drizzle-kit's
  `--> statement-breakpoint`. The hash covers the canonical ops, so reformatting the JSON is not
  an edit.
- The migrator takes a `MigrationDriver` (execute, query) instead of `SqlClient` directly, with
  `fromSqlClient(sql, { command })` as the adapter: ClickHouse DDL has to go through the
  client's `asCommand`, and the query path fails on statements with no result.
- `.ts` migrations that export an Effect are not implemented.
- `verify` checks tables, engine family, keys, columns (type, default), skipping indexes, and
  view targets and bodies. TTL, codecs, settings, and comments are not compared yet.
- `check` treats two branches as conflicting when they change the same table (columns and
  indexes count as their table), not per column as drizzle-kit's footprints do. Coarser, simpler,
  and safe.
- `generate` bumps the timestamp past any prefix already in the folder, so two migrations never
  share a second; `check` rejects a migration that sorts before its parent.

**Not done (phase 4 onward).** Rename detection, column type changes, table rebuilds, windowed
backfills, `minServerVersion` entities, `pull` / `push` / `--init`, Postgres. `generate`
reports the unsupported changes by name and writes nothing, rather than guessing.

**Tests.** `src/schema/schema.test.ts` and `src/kit/*.test.ts` run offline (definitions,
rendering, diff, snapshots, the CLI in a temp folder, branch analysis).
`tests/migrate.clickhouse.test.ts` runs against a live server: apply and verify clean, an
additive change with a recreated view checked with real inserts, resume after a failed
statement, hash mismatch under `strict`, the lease, and drift. Passing on 26.2.19.43 and 26.8.2.7.
`tests/package-consumer.mts` imports all three entry points from the packed tarball under Node.

---

## 8. Postgres (phase 6)

Open question 1 is answered with full authoring, not runtime-only: Maple's Postgres schema
(70 tables, 76 drizzle-kit migrations) was the consumer, and keeping drizzle-kit for authoring
would have meant two definitions per table.

**Where the dialect seam is.** Shared: the snapshot envelope (`Snapshot` is a union over
`dialect`), `entityKey` / `sortEntities` / hashing, the branch graph (`kit/graph.ts`), folder
loading, `MigrationDriver`. Per dialect: entities (`pg-entities.ts`), definitions
(`pg-define.ts`, exported as `S.pg`), the diff (`pg-diff.ts`), ops and DDL (`pg-ops.ts`), the
ledger (`pg-ledger.ts`), drift (`pg-verify.ts`). `run`, `status`, `verify` and `generate` pick
the dialect from the config or the snapshots and dispatch; nothing ClickHouse-specific moved.

**Runtime.** One transaction per migration, ledger row included, under
`pg_advisory_xact_lock`: transaction-scoped, so a pooled connection cannot leak the lock. The
ledger is a plain table with a primary key. The ClickHouse step journal and lease are not used.

**Drift without normalizing SQL.** The catalog stores `'open'` as `'open'::text` and
`status in ('a', 'b')` as `(status = ANY (ARRAY[...]))`; any text normalizer would be a
heuristic. `verify` instead renders the snapshot into a scratch schema inside a transaction it
always rolls back, and reads both catalogs with the same queries. Checked against Maple: its 76
migrations replayed on PGlite, baselined from drizzle-kit's last snapshot, verify clean except
two real orphans (a table and a column the SQL created and no migration dropped, absent from
drizzle-kit's snapshot).

**Adoption.** A drizzle-kit `snapshot.json` is recognized (it has `ddl`, not `entities`) and
kept aside as `foreignSnapshot`. Migrations sorting before the first effect-orm snapshot are
legacy: `check` accepts them, `generate` refuses to diff until `--baseline` (from the
definitions, or `--from-drizzle` from drizzle-kit's last snapshot) starts the history.
`Migrate.baseline` records already-applied migrations without running them.

**Not done.** Check and unique constraints, enums, views, sequences beyond identity defaults,
non-`public` schemas, `CREATE INDEX CONCURRENTLY` (needs a migration outside a transaction),
rename detection, and `pull` / `push`.

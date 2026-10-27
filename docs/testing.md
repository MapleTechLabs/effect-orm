# Testing and release checks

The release target is the builder's supported API, not the entire ClickHouse SQL
language. The standalone suite uses public package exports from a fresh build and
executes deterministic SELECT/CTE fixtures. It does not create tables or write data.

## Commands

Run these from the repository root:

```sh
bun run build
bun run typecheck
bun run test
```

`test` includes SQL generation, type/codec regressions, the dialect coverage manifest,
and documentation checks. Live tests skip when no endpoint is configured.
`typecheck` also checks the compile-time assertion files under `src/`, live
fixtures under `tests/`, and TypeScript release scripts under `scripts/`; build first because the latter import public exports.

For live tests against an existing local server:

```sh
EFFECT_ORM_CLICKHOUSE_URL=http://127.0.0.1:8123 \
EFFECT_ORM_CLICKHOUSE_USER=maple \
EFFECT_ORM_CLICKHOUSE_PASSWORD=maple \
bun run test:clickhouse
```

`test:clickhouse` builds the package and requires an endpoint. Missing configuration,
an unreachable server, a failed assertion, or a decoding error fails the command.
The user defaults to `default` and the password to an empty string.

`bun run test:package` builds and packs the package, installs the tarball outside the
workspace with its Effect peer, typechecks a consumer with strict declarations, and
executes imports from the public entry points under Node. This needs npm registry
access. It uses the installed Effect and TypeScript versions, with explicit Node, DOM,
and disposable type libraries required by the Effect declarations.

`bun run test:release` requires the same ClickHouse environment and runs build,
typecheck, all tests (including live tests), documentation checks, and the isolated
tarball check. `prepublishOnly` runs it too, so publishing cannot silently skip live
checks. Packing for inspection uses `npm pack --ignore-scripts` and never publishes.

## What the manifest guarantees

`tests/dialect-cases.ts` is the fixture manifest. Each case names the features it
covers and asserts complete decoded result rows. `tests/dialect-coverage.test.ts`
discovers the function barrel, built query/union methods, and public type descriptors,
and rejects missing coverage, stale entries, duplicate case IDs, and redundant
exemptions. Add a case or a specific exemption when extending those APIs.

The inventory covers the wrapped ClickHouse functions (including `/expr` names),
query and union methods, and built-in type descriptors. It is not a percentage of
ClickHouse's grammar, every overload, every input combination, or every low-level
expression/SQL factory. Those also have unit and consumer checks. Custom and untyped
descriptors are explicit extension points: their factories are smoke-tested, but the
caller's SQL type and schema remain the caller's responsibility.

Cases cover normal results plus selected empty inputs, nullable/nested values,
64-bit identity preservation through `toString`, parameter escaping, grouped windows,
and joins against nullable unions. Each case runs under both quoted/unquoted 64-bit
JSON output and default/nullable outer joins. The original publishing regression
suite additionally checks unmatched joins under both settings and DateTime64 bounds.
Fixtures pin the session timezone to UTC, matching the timestamp codecs' wire contract.
Both JSON and JSONEachRow response formats are exercised.

## One builder suite, every dialect

`tests/core-cases.ts` holds the builder cases every dialect runs: selection, the shared
operators, params, grouping, joins on tables and subqueries, CTEs, unions, routing, and
`format`. A case builds its query from a `CoreContext`, which supplies the dialect's column
types, aggregate catalog and `compile`, and reads the same fixture rows on every database
(a `WITH` over `values(...)` on ClickHouse and `VALUES` on Postgres, so nothing is written).

- `tests/core.clickhouse.test.ts` runs them live, under both `join_use_nulls` settings.
- `tests/core.postgres.test.ts` runs them on PGlite (Postgres 17) on every `vitest run`.
- `tests/core-sql.test.ts` snapshots the exact SQL and `parameters` per dialect.

Where the databases genuinely disagree, the case says so: `expectedBy` gives a target its
own rows (`/` is integer division on Postgres; ClickHouse fills a missing join row with
defaults unless `join_use_nulls=1`), and `rejects` names a dialect that must refuse to
compile it (`format` on Postgres). A case a dialect cannot run yet goes in `coreSkips`
with a reason. The core manifest in `tests/dialect-coverage.test.ts` requires every query
and union method, expression and condition operator, and param kind to have a core case.

Postgres functions and types have their own manifest: every export of the `./postgres`
entry that is its own (not the shared query builder, which the ClickHouse manifest covers) is
run by a case in `tests/dialect-cases.postgres.ts` (`tests/dialect.postgres.test.ts`)
or exempted with a reason.

Tests preserve documented behavior: arithmetic chains follow SQL precedence, not call
order, and `windowFunnel` with `strict_order` rejects intervening events.

## Fuzzing

`tests/fuzz/` generates schema-shaped inputs with Effect Arbitrary and SQL plans
with fast-check, checking them against independent oracles:

- `literals.fuzz.test.ts`: a random value of each catalogued column type reaches each target twice. One
  copy goes through the database's own JSON parser as the reference, the other through the
  builder, both as a comparison literal and as a param in the SELECT list. The two must agree.
- `queries.fuzz.test.ts`: random query plans (joins, nested conditions, grouping, having,
  ordering, paging, subqueries) run on the core fixture and generated tables and must match `model.ts`, a JS
  evaluator with SQL three-valued logic. A plan that reports `single-tenant` must have read
  one org's rows only.
- `compile.fuzz.test.ts`: needs no database. Valid plans always compile, compile
  deterministically, leak no `undefined`, `NaN` or `__PARAM_`, and number Postgres
  placeholders `$1..$n`. Any JS value placed where a value goes is compiled or refused with a
  `QueryBuilderError`, never thrown and never a defect.
- `codecs.fuzz.test.ts`: Effect `TestSchema` verifies composed codec round trips;
  schema-generated rows survive compiled encoding/decoding, and malformed wire rows
  fail with a typed decode error.
- `migrations*.fuzz.test.ts`: SQLite/D1 and Postgres transitions are compared with
  freshly created schemas and independent seed-row expectations, using varied text,
  numeric, JSON, array and binary payloads as supported by each suite.
- `registry.fuzz.test.ts`: every dialect and public type export must have a literal
  property or an explicit exemption.

`bun run test` runs a small budget (a few seconds). Use `bun run fuzz` for longer runs:

```sh
FUZZ_SCALE=50 bun run fuzz          # 50× every property's default run count
FUZZ_RUNS=10000 bun run fuzz -t "plans match the model"
FUZZ_VERBOSE=1 bun run fuzz         # print checked / skipped counts per property
```

A failure prints the shrunk input, the SQL it compiled to, the database's reply, and a
`FUZZ_SEED=… FUZZ_PATH=…` command that replays it. Effect-native properties print an
opaque token instead; use `FUZZ_REPLAY=…` with the failing test name. See [the fuzz guide](../tests/fuzz/README.md) for generator
choices and replay details. Pin the input in
`tests/fuzz/regressions.ts`, which is replayed before any random input.

Bugs found but not yet fixed live in `tests/fuzz/known-issues.ts`. Each entry recognises
the inputs that reach its bug and gives a reason, so the suite stays green while the rest of
the input space keeps being fuzzed. `FUZZ_STRICT=<id>` re-enables one entry's inputs, to check a
fix before deleting the entry; `FUZZ_STRICT=1` re-enables them all. Differences
between the databases that are not bugs are encoded in the model instead, each with the
difference it represents.

## Version and CI policy

Every push to `main` and every pull request runs the complete release check against
pinned **26.2.19.43** and **26.8.2.7** servers in `.github/workflows/ci.yml`.
These are tested compatibility points; older versions are not established by this suite.
The workflow is also manually dispatchable and reusable by a publishing workflow.
It validates but does not publish. Its results apply only to the commit tested.

## Upstream references

ClickHouse's [stateless functional tests](https://github.com/ClickHouse/ClickHouse/tree/master/tests/queries/0_stateless)
and [testing guide](https://clickhouse.com/docs/resources/develop-contribute/contribute/tests)
are useful sources of additional edge cases. Port relevant operations into the DSL
and retain provenance when copying fixtures. Executing upstream SQL unchanged would
not validate the builder. The current small fixtures were written for this package.

## Testing your own code: `layerTest`

`Db.layerTest(options)` from `/database` is a `Database` with no server, for the unit tests of
code that runs queries. Provide it in place of your real `Database` layer; no module mocks are
needed. It also gives `TestDatabase`, which records what was sent and holds the replies.

```ts title="database-test-layer.ts"
import { Effect } from "effect"
import * as Db from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"

const Accounts = PG.table("accounts", { columns: { id: PG.int4, org: PG.text, balance: PG.int8 }, primaryKey: ["id"] })

// The code under test: it knows only `Database`.
const balances = (org: string) =>
	Db.run(
		PG.from(Accounts)
			.select("id", "balance")
			.where(($) => [$.org.eq(org)]),
	)

export const result = await Effect.runPromise(
	Effect.gen(function* () {
		const test = yield* Db.TestDatabase
		// Rows as the server sends them: Postgres returns int8 as a string.
		yield* test.reply([{ id: 1, balance: "70" }])
		const rows = yield* balances("org_1")
		const [sent] = yield* test.statements
		return { rows, parameters: sent?.parameters }
	}).pipe(Effect.provide(Db.layerTest({ dialect: PG.postgresDialect }))),
)
// { rows: [{ id: 1, balance: 70 }], parameters: ["org_1"] }
```

Only the server is replaced. The layer is `fromSqlClient` over a fake `SqlClient`, so the rest
runs as in production:

- `run` compiles for the dialect you give. `statements` holds the SQL and `parameters` exactly
  as a server would get them.
- Rows are decoded by the query's own row schema. A row that does not match fails with
  `CompiledQueryDecodeError`, as it would from a server.
- `transaction` records `BEGIN`, `COMMIT`, `ROLLBACK` and savepoints in `statements`. They
  take no reply. On `clickhouseDialect` it fails with `TransactionUnsupported`.
- `requireTenantScope: true` refuses an unscoped query, as on `fromSqlClient`.

Each statement takes the next queued reply. With no reply queued, it gets `respond(statement)`
from the options, or no rows. A reply is an array of rows, or a driver `SqlError` from
`effect/sql/SqlError`. A driver error becomes the same `DatabaseError` a real driver's would,
with its `reason` and `sqlState`:

```ts
yield* test.reply(
	new SqlError({ reason: new UniqueViolation({ cause: { code: "23505" }, constraint: "accounts_pkey" }) }),
)
const error = yield* Effect.flip(insertAccount)  // DatabaseError, reason "UniqueViolation", sqlState "23505"
```

| Export | What it is |
| --- | --- |
| `layerTest(options)` | A `Database` and a `TestDatabase`, with no requirements |
| `TestDatabase` | The control side: `statements`, `reply(...replies)`, `reset` |
| `TestDatabaseOptions` | `dialect` (required), `respond`, `requireTenantScope` |
| `TestReply` | Rows as the server sends them, or a `SqlError` |
| `TestStatement` | `{ sql, parameters }`, as received |

The fake does not run SQL. A test that needs real SQL semantics (constraints, joins over stored
rows) needs a real database: PGlite for Postgres, as in [Database](./database.md#a-complete-example).
A COMMIT or ROLLBACK that fails cannot be scripted yet.

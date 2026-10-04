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

# The fuzzer

Property-based tests for the query builder and codecs, run with Effect Arbitrary
and fast-check. Database properties run on real engines. They catch
what hand-written cases miss: SQL that runs but returns the wrong rows, escaping
bugs, and values the builder throws on instead of refusing.

```sh
bun run test                 # every property at its smoke budget (part of the normal suite)
bun run fuzz                 # the fuzz suites only
FUZZ_SCALE=20 bun run fuzz   # a soak: 20× each property's runs (the nightly workflow)
```

ClickHouse targets run when `EFFECT_ORM_CLICKHOUSE_URL` (and `_USER`, `_PASSWORD`) are set
and are skipped otherwise. Postgres runs in-process on PGlite.

## Suites

| File | Property | Oracle |
| --- | --- | --- |
| `queries.fuzz.test.ts` | random plans and `unionAll`s, over both the core fixture and generated empty/duplicate/nullable/multi-tenant data, return the rows `model.ts` computes | a JS model of SQL, per target |
| `writes.fuzz.test.ts` | random sequences of inserts (multi-row, defaulted cells, INSERT … SELECT, ON CONFLICT), updates and deletes, with RETURNING, leave a scratch table as the model says; unsupported writes are refused | a JS model of the table's rows |
| `literals.fuzz.test.ts` | every column type's values survive as a literal and as a param | the database's own JSON parser |
| `compile.fuzz.test.ts` | plans compile deterministically, with no leaked JS or misaligned placeholders; hostile values are refused with a typed error | invariants |
| `migrations.fuzz.test.ts` | a SQLite migration between two random schemas (with table and column renames), run on seeded rows on node:sqlite and on D1 (one batch per migration), gives a fresh create's PRAGMA shape and keeps varied text, numeric and binary payloads; a drizzle-kit snapshot of any schema imports with nothing to generate | a fresh create, the seeded rows, and our own entities |
| `migrations.postgres.fuzz.test.ts` | random Postgres table/column/default/nullability/index transitions reach a fresh create's shape and preserve scalar, JSON and array rows | PGlite catalogs and independent seed values |
| `codecs.fuzz.test.ts` | schema-derived values round-trip through composed codecs and compiled row codecs; malformed wire rows fail with a typed decode error | Effect `TestSchema`, schema equivalence and explicit wire corruptions |
| `registry.fuzz.test.ts` | every dialect and public type export has fuzz coverage or an explicit reason | public exports and the literal catalog |

## Choosing a generator

Use Effect's native `Arbitrary.schema` for schema-shaped values: nested JSON,
UUIDs, booleans, brands and codec properties. `TestSchema.Asserts.verifyRoundTrip`
checks compositional encode/decode behavior. The shared harness accepts native
Effect arbitraries directly, preserving shrinking and replay; do not sample them
into fast-check constants, which loses their shrink tree.

Native properties discard inputs during generation with `Arbitrary.filter` (or
schema checks). Effect's checker has no predicate-level discard result: throwing
`skip()` or `skipKnown()` inside a native predicate fails with a diagnostic. Keep
oracle limitations in native generator filters; rejected candidates do not consume
the run budget, and exhausting generation fails instead of passing with no checks.

Keep fast-check's constrained generators for SQL domains, adversarial strings and
well-typed query/migration plans. A descriptor's wire codec can be broader than
its storage type: `UInt8.schema` accepts finite numbers, while valid SQL inputs
must be integers from 0 to 255. Schema-derived tests complement the independent
database/model oracles rather than replacing them.

Both engines use `FUZZ_RUNS`, `FUZZ_SCALE` and `FUZZ_SEED`. Effect failures print an
opaque replay token; select the failing property and replay with:

```sh
FUZZ_REPLAY='…' bun run fuzz -t 'compiled row codec rejects malformed wire \(postgres\)'
```

`FUZZ_PATH` belongs to fast-check; `FUZZ_REPLAY` belongs to Effect. Replay tokens
are version-specific. Pin important inputs in `regressions.ts` as well. A property
whose every input is discarded now fails, including known-issue skips; hitting a
configured time budget also fails rather than reporting partial coverage as success.

## Adding a dialect

Write `dialects/<name>.ts` exporting a `FuzzDialect` (see `dialects/types.ts`)
and add it to `dialects/index.ts`. `registry.fuzz.test.ts` fails until you do.
Every suite then runs on it with no other edit.

A `FuzzDialect` gives:

- `module`: the package entry (`/postgres`, …) the plans are built and compiled with.
- `context`: the core fixture as CTEs over literal rows (`tests/core-cases.ts`),
  so every database reads the same rows.
- `strings` and `ilike`: what the generators may produce for it.
- `literals`: its column types, each with a way to build the reference row
  *without* the builder (usually the database parsing JSON).
- `writes`: which writes its builder compiles (`insertSelect`, `update`, `delete`,
  `onConflict`, `returning`, `defaultCells` for a multi-row VALUES that leaves a
  defaulted column out of some rows), and a `scratch` table: its query `Table`,
  the DDL that creates and drops it, and `exec` to run that DDL on the first
  target. Set a capability from what the builder does, not what the database
  could: the suite still generates an unsupported write and requires the builder
  to refuse it. A database whose writes are asynchronous (ClickHouse mutations)
  must make them visible to the next read (`mutations_sync=2`).
- `targets`: the databases it runs on. Each target states its `Semantics`, the
  points where databases legitimately disagree (NULL ordering, integer division,
  what an unmatched LEFT JOIN column holds, LIKE case rules, …). The model reads
  only these. **Never branch on a target's name in `model.ts`.** If a database
  differs in a new way, add a field to `Semantics` and set it for every target.

A difference belongs in `Semantics` only when it is the database's documented
behaviour and the builder cannot reasonably hide it. When the builder *could*
make the dialects agree, the difference is a bug: record it in
`known-issues.ts` and fix it.

## Writing generators that find bugs

- **Derive values from the fixture.** A random string almost never equals a
  fixture value, so `eq` and `LIKE` over random strings test only the empty
  result. `plan.ts` mixes in fixture values (`FIXTURE_STRINGS`), the fixture's
  numbers (`smallInt`), times around `Created`, and LIKE patterns made by
  editing fixture values (re-cased, wildcarded, escaped). That last change is
  what made SQLite's case-insensitive, escape-less LIKE visible.
- **Keep plans as data.** The generator never calls the builder: `plan.ts` makes
  a `Plan`, `build.ts` turns it into builder calls, `model.ts` evaluates it. A
  failure prints the shrunk plan, and the plan can be pinned.
- **Well-typed by construction.** Expressions are generated by sort, so a
  refusal from the builder is a finding, not noise.
- **Check that inputs are judged.** Run with `FUZZ_VERBOSE=1`: each property
  prints how many inputs it checked and why it skipped the rest. A property that
  skips most of its inputs is testing nothing.

## When a property fails

The report prints the shrunk input, the SQL, the outcome, and a replay command:

```sh
FUZZ_SEED=… FUZZ_PATH=… bun run fuzz -t 'plans match the model \(postgres, plain strings\)'
```

1. Decide whose bug it is: the builder, the model, or the database.
2. Builder bug: fix it, then pin the input in `regressions.ts` so it is replayed
   before any random input from then on.
3. Not fixable now: add an entry to `known-issues.ts` with a reason someone can act
   on. The suite stays green and the rest of the input space keeps being fuzzed.
   `FUZZ_STRICT=1` (or `FUZZ_STRICT=<id>`) turns entries back on to check a fix.
4. Model bug or a legitimate database difference: fix `model.ts`, or add a
   `Semantics` field (see above).

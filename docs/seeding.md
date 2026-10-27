# Seeding

`@maple-dev/effect-orm/seed` makes test and demo rows from a table's column types. Each column
type is an Effect `Schema`, so its values come from Effect's own `Schema` → `Arbitrary`
derivation. You write no generator configuration. The entry needs nothing beyond `effect`.

```ts
import { Arbitrary, Effect } from "effect"
import * as Db from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"
import * as Seed from "@maple-dev/effect-orm/seed"

const Orgs = PG.table("orgs", { columns: { id: PG.text, name: PG.text }, primaryKey: ["id"] })

const Members = PG.table("members", {
	columns: {
		id: PG.int4,
		org_id: PG.text,
		email: PG.column(PG.text, { unique: true }),
		age: PG.int2,
		joined: PG.column(PG.timestamptz, { defaultExpr: "now()" }),
	},
	primaryKey: ["id"],
	tenantColumn: "org_id",
})

const seedMembers = Seed.rows(Members, {
	count: 3,
	seed: 42,
	tenant: "org_1",
	columns: { email: (i) => `member${i}@example.com`, age: Seed.pick([30, 40]) },
})

// yield* Seed.insert(Members, { count: 1000, seed: 42, tenant: "org_1" })
```

_(Backed by `docs/seeding.md > Seed rows from the column Schemas`.)_

| Function                    | Returns                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `rows(table, options)`      | `count` rows as decoded values. Nothing is written.                                       |
| `insert(table, options)`    | The same rows, inserted with `insertInto(table).values(...)` on the `Database` in context. |
| `arbitrary(table, options)` | An `Arbitrary` of whole rows, for property tests with `Arbitrary.checkEffect`.            |
| `pick(values)`              | An `Arbitrary` that picks one of `values` per row, for a foreign key.                     |

All three seed functions fail with `SeedError` (`table`, `column`, `message`) when they cannot make
the rows. `insert` can also fail with the errors of `Database.run`.

## Deterministic

The same `seed` (a number or a string, default `0`), table and options give the same rows. Each
column samples from its own seed, made from the run's seed and the column's key. Thus a column you
add later does not change the values of the other columns.

## Which columns get values

- Every writable column gets values. Computed columns (ClickHouse `MATERIALIZED` and `ALIAS`) do
  not.
- A column with a database default (`default`, `defaultExpr`, `identity`) is left to the database.
  It gets values only when you give it an override.
- A nullable column is NULL in about one row in four.
- The row type is `SeedRowOf<typeof Members>`: every column as its decoded type, and a defaulted
  column as optional.

## Values the database can store

A Schema says what a column decodes to, not what the database can store. `CH.uint8` decodes to
any finite number, and `PG.timestamptz` to any instant. Thus the built-in column types add the
storage range of the SQL type:

| Column type                                | Values                                                         |
| ------------------------------------------ | -------------------------------------------------------------- |
| `UInt8` … `UInt64`, `Int32`, `Int64`       | Integers in the type's range, 64-bit ones as safe integers      |
| `int2`, `int4`, `int8`                     | The same                                                       |
| `float4`                                   | Single-precision values                                        |
| `DateTime`, `DateTime64`                   | 1970-01-02 to 2106-02-06 and 1900-01-02 to 2299-12-30, in every server time zone |
| `timestamptz`                              | Years 100 to 9999                                              |
| `uuid`                                     | Lowercase version 4 UUIDs                                      |
| `text`, `jsonb`                            | No U+0000, which Postgres cannot store                         |
| `Array`, `Map`                             | Up to 4 elements and 3 entries                                 |

No string has a lone surrogate, and no number is `-0`. A database stores neither as given.

A branded or refined column (`PG.brand(PG.text, Slug)`) gets only values that its Schema accepts,
because the Schema's checks drive the generation. A column type of your own (`custom`) gets values
from its Schema alone. If its Schema has no arbitrary, or the SQL type is narrower than the Schema,
give the column an override.

## Overrides

`columns` gives a column one of these in place of its derived values:

- A value, the same for every row: `{ plan: "free" }`, `{ note: null }`.
- An `Arbitrary` to sample: `Seed.pick([...])`, or `Arbitrary.schema(MySchema)`.
- A function of the row's index: ``(i) => `member${i}@example.com` ``.

A value, and each value that a function returns, must be a value of the column's Schema. If not,
seeding fails with `SeedError`. `arbitrary` takes values and `Arbitrary`s only, because a property
test has no row index.

## Unique columns

A column in `unique` gets distinct values. A Postgres table's one-column primary key and its
`unique: true` columns are added from its DDL. When the column's values cannot give `count`
distinct ones (a `bool` key, a short `Literals` list), seeding fails with `SeedError`. Then give
the column a function of the row index.

## The tenant column

A table that declares a [tenant column](./tenant-scoping.md) needs one of:

- `tenant: "org_1"`: every row belongs to this tenant. `insert` then compiles as `"single-tenant"`,
  so a `Database` with `requireTenantScope` runs it.
- `crossTenant: true`: the tenant column gets values like any other column, and `insert` declares
  its statements `crossTenant()`.

Without one of them, seeding fails with `SeedError`. This stops a seed that writes rows of
tenants you did not intend.

## Inserting

`insert` writes `batchSize` rows per `INSERT` (default 100), in order, through `insertInto`. It
returns the rows, so a later seed can pick its foreign keys from them:

```ts
const seedOrgsAndMembers = Effect.gen(function* () {
	const orgs = yield* Seed.insert(Orgs, { count: 10, seed: 1 })
	const ids = orgs.map((org) => org.id) as [string, ...Array<string>]
	return yield* Seed.insert(Members, { count: 500, seed: 1, crossTenant: true, columns: { org_id: Seed.pick(ids) } })
})

// yield* Db.transaction(seedOrgsAndMembers)
```

A failed batch stops the seed. Run it in `transaction` to keep all of it or none of it, where the
dialect has transactions. On Postgres, a statement can bind at most 65535 parameters: keep
`batchSize` times the column count below that.

## Property tests

`arbitrary` gives whole rows to `Arbitrary.checkEffect`, so the same column Schemas drive a
repository's property tests:

```ts
const property = Effect.gen(function* () {
	const members = yield* Seed.arbitrary(Members, { tenant: "org_1" })
	return yield* Arbitrary.checkEffect(members, (member) => member.org_id === "org_1", { runs: 100 })
})
```

## Not yet

- Seeding a whole schema in foreign-key order. Seed the parent tables first and `pick` from their
  rows, as above.
- Distinct values over several columns (a composite unique). Give one of the columns a function of
  the row index.
- Realistic values (names, emails, cities) as `drizzle-seed` gives them. Use an override.

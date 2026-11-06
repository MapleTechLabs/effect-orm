# Coming from Drizzle or Prisma

This page maps the Prisma and Drizzle operations you use every day to effect-orm. Its examples
use Postgres. SQLite and Cloudflare D1 (`@maple-dev/effect-orm/sqlite`) have the same builder,
`RETURNING` and `ON CONFLICT`; where a row differs on them, it says so, and
[SQLite and Cloudflare D1](./sqlite.md) has the details. Each row says where effect-orm has the
operation today.

Two things change for every operation:

- A query is a value. `PG.from(...)` builds it, and `Db.run` compiles it for the database's
  dialect, runs it, and decodes its rows. There is no client object with model methods.
- `Db.run` returns an `Effect`. Errors are in its type, and the `Database` it needs is in its
  requirements.

## Operations

| Prisma | Drizzle | effect-orm |
| --- | --- | --- |
| `findUnique({ where })` | `db.query.t.findFirst({ where })` | `Db.runOption(PG.from(T).select(...).where(...))`: `Option` of the row, a failure for more than one; `Db.runOne` when it must exist ([Cardinality](./database.md#cardinality)) |
| `findFirst`, `findMany({ where, orderBy, take, skip })` | `db.select().from(t).where().orderBy().limit().offset()` | `.where`, `.orderBy`, `.limit`, `.offset` ([Building queries](./queries.md)) |
| Many `findUnique` calls batched (the dataloader) | none | `Db.findById` and `Db.findAllBy`: concurrent lookups by a key become one `IN` statement ([Batching lookups](./database.md#batching-lookups)) |
| `include` / `select` a relation | `with: { posts: true }` | `Db.findMany` with nested `with` over `Db.defineRelations`, one statement per level ([Relational reads](./relations.md)); or `innerJoin` / `leftJoin` ([Joins](./joins-and-subqueries.md)) |
| `_count: { select: { posts: true } }` | `db.$count(posts, eq(...))` | `_count: { posts: true }` in `Db.findMany` ([Count relations](./relations.md#count-relations)); or `leftJoin` + `PG.countDistinct` + `groupBy` |
| `where: { posts: { some / none / every } }` | `exists(...)` | `r.posts.some(where)`, `none`, `every` in a `findMany` `where` ([Filter by relations](./relations.md#filter-by-relations)); or `PG.exists`, `PG.inSubquery` ([Subquery conditions](./joins-and-subqueries.md#subquery-conditions)) |
| `create`, `createMany({ data })` | `db.insert(t).values([...])` | `PG.insertInto(T).values(row or rows)`, `.returning()` ([Inserting rows](./inserts.md)) |
| `upsert` | `.onConflictDoUpdate({ target, set })` | `.onConflictDoUpdate({ target, set })`; `set: PG.excluded([...])` or `PG.excludedAll()` copies the proposed row ([On conflict](./inserts.md#on-conflict)) |
| `update`, `updateMany` | `db.update(t).set().where()` | `PG.update(T).set(...).where(...)`; a write with no `where` or `allRows()` does not compile ([Updating and deleting](./updates-and-deletes.md)) |
| `delete`, `deleteMany` | `db.delete(t).where()` | `PG.deleteFrom(T).where(...)` |
| `$transaction(async (tx) => ...)` | `db.transaction(async (tx) => ...)` | `effect.pipe(Db.transaction())`; no `tx` handle, nesting is a savepoint ([Transactions](./database.md#transactions)). D1 has no interactive transactions: there `Db.transaction` fails with `TransactionUnsupported` |
| `$transaction([a, b])` | `db.batch([a, b])` | Run them inside one `Db.transaction`. There is no single-round-trip batch, and no wrapper for D1's `batch` yet ([D1](./sqlite.md#execute-on-d1)) |
| `$queryRaw`, `$executeRaw` | `` db.execute(sql`...`) `` | `` Db.query(Db.sql`...`, schema) ``, `` Db.execute(Db.sql`...`) ``; every `${value}` is bound |
| `SELECT ... FOR UPDATE` by `$queryRaw` | `.for("update")` | `.forUpdate()`, `.forNoKeyUpdate()`, `.forShare()` on Postgres, `.forUpdate()` and `.forShare()` on MySQL ([Building queries](./queries.md)); SQLite has no row locks |
| `P2002` (unique violation) | `DrizzleQueryError` and a `cause.code` check | `Db.refineConstraints` fails with a tagged `UniqueViolation` (and `ForeignKeyViolation`, `NotNullViolation`, `CheckViolation`) to catch by tag ([Constraint violations](./database.md#constraint-violations)) |
| `cursor`, `skip: 1`, `take` | `where(gt(t.id, cursor))` | `Db.paginate(query, { orderBy, limit, after })`: a keyset page and the cursor for the next ([Pagination](./database.md#pagination)) |
| `contains`, `mode: "insensitive"` | `ilike(t.c, "%x%")` | `$.c.contains("x")`, `startsWith`, `endsWith`, with `{ insensitive: true }`; user input is escaped, on every dialect ([Text search](./expressions.md#text-search)) |
| `Json` field, `path` filters | `jsonb()`, `` sql`->>` `` | `PG.jsonb(schema)` decodes the document with a Schema; `PG.jsonPath($.c, "a", "b")`, `PG.jsonContains` (`@>`) and `PG.jsonSet` (`jsonb_set`) are typed from it ([JSON paths](./postgres.md#json-paths)). Postgres only |
| `@default(uuid())`, `@default(now())` | `.defaultRandom()`, `.defaultNow()` | `PG.column(type, { defaultExpr: "gen_random_uuid()" })`, `{ defaultExpr: "now()" }` |
| `@default(cuid())`, `@updatedAt` | `.$defaultFn()`, `.$onUpdate()` | `PG.column(type, { defaultFn: effect, onUpdate: effect })`: Effects `Db.run` runs into each write ([Client-side defaults](./inserts.md#client-side-defaults)) |
| `@map("org_id")`, `@@map` | `text("org_id")` | `PG.column(PG.text, { name: "org_id" })`; the table name is the first argument of `PG.table`; `casing: "snake_case"` maps every key ([Column names](./tables-and-types.md#column-names)) |
| `@@unique`, `@@index`, relations with `onDelete` | `unique()`, `index()`, `references()` | `uniqueConstraints`, `indexes`, `foreignKeys` on `PG.table` ([Postgres migrations](./migrations.md#postgres)). `SQLite.table` declares keys and indexes, not foreign keys ([SQLite](./sqlite.md#declare-a-table-with-its-ddl)) |
| `prisma db seed` | `drizzle-seed` | `Seed.insert(T, { count })` writes rows generated from the column Schemas, deterministic by seed ([Seeding](./seeding.md)) |
| `prisma migrate dev` / `deploy` | `drizzle-kit generate` / `migrate` | `effect-orm generate`, `effect-orm migrate` ([Schema and migrations](./migrations.md)). A drizzle-kit folder can be adopted. SQLite has `generate` only; a drizzle-kit-compatible tool applies its folders ([SQLite migrations](./migrations.md#sqlite)) |
| `prisma db pull` | `drizzle-kit pull` | `effect-orm pull` for ClickHouse only; Postgres and SQLite are not supported yet |
| `prisma migrate diff` (drift) | none | `effect-orm verify --schema` compares the database with the table definitions ([Checking the definitions](./migrations.md#checking-the-definitions-against-a-database)) |
| `prisma migrate status` | `drizzle-kit check` | `effect-orm status`; `effect-orm check` validates the migrations folder, as `drizzle-kit check` does |
| A mocked client in unit tests | a mocked `db` | `Db.layerTest` answers statements with no server ([layerTest](./testing.md#testing-your-own-code-layertest)); or run on PGlite, as below, or in-memory SQLite |

## The table above, as one program

This runs on PGlite, Postgres compiled to WASM, so it needs no server. Each comment names the
Prisma call that the next statement replaces. `requireTenantScope` is on, so every statement
must pin `orgId`, or `Db.run` refuses it.

```ts title="coming-from-prisma.ts"
import { PgliteClient } from "@effect/sql-pglite"
import { Effect, Layer, Schema } from "effect"
import * as Db from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"
import * as S from "@maple-dev/effect-orm/schema"

const Profile = Schema.Struct({ city: Schema.String })

// model User { id String @id @default(uuid()); email String @unique; orgId String @map("org_id") ... }
export const Users = PG.table("users", {
	columns: {
		id: PG.column(PG.uuid, { defaultExpr: "gen_random_uuid()" }),
		orgId: PG.column(PG.text, { name: "org_id" }),
		email: PG.column(PG.text, { unique: true }),
		profile: PG.jsonb(Profile),
		updatedAt: PG.column(PG.timestamptz, { name: "updated_at", defaultExpr: "now()" }),
	},
	primaryKey: ["id"],
	tenantColumn: "orgId",
})

export const Posts = PG.table("posts", {
	columns: {
		id: PG.int4,
		orgId: PG.column(PG.text, { name: "org_id" }),
		authorEmail: PG.column(PG.text, { name: "author_email" }),
		published: PG.bool,
	},
	primaryKey: ["id"],
	foreignKeys: [PG.foreignKey({ columns: ["authorEmail"], references: Users, foreignColumns: ["email"], onDelete: "cascade" })],
	tenantColumn: "orgId",
})

const org = "org_1"

// prisma.user.findUnique({ where: { email } })
const findByEmail = (email: string) =>
	Db.run(
		PG.from(Users)
			.select("id", "email")
			.where(($) => [$.orgId.eq(org), $.email.eq(email)])
			.limit(1),
	).pipe(Effect.map((rows) => rows[0]))

export const program = Effect.gen(function* () {
	for (const statement of S.renderPgSchema(yield* S.pgEntitiesOf([Users, Posts])))
		yield* Db.execute({ sql: statement, parameters: [] })

	// prisma.user.createMany({ data: [...] })
	yield* Db.run(
		PG.insertInto(Users).values([
			{ orgId: org, email: "ada@example.com", profile: { city: "London" } },
			{ orgId: org, email: "bob@example.com", profile: { city: "Paris" } },
		]),
	)
	yield* Db.run(
		PG.insertInto(Posts).values([
			{ id: 1, orgId: org, authorEmail: "ada@example.com", published: true },
			{ id: 2, orgId: org, authorEmail: "ada@example.com", published: false },
		]),
	)

	const found = yield* findByEmail("ada@example.com")

	// prisma.user.findMany({ where: { email: { contains: "EXAMPLE", mode: "insensitive" } }, orderBy, take })
	const insensitive = yield* Db.run(
		PG.from(Users)
			.select("email")
			.where(($) => [$.orgId.eq(org), $.email.ilike("%EXAMPLE%")])
			.orderBy(["email", "asc"])
			.limit(10),
	)

	// include: { _count: { select: { posts: true } } }
	const counts = yield* Db.run(
		PG.from(Users, "u")
			.leftJoin(Posts, "p", (u, p) => u.email.eq(p.authorEmail).and(u.orgId.eq(p.orgId)))
			.select(($) => ({ email: $.email, posts: PG.countDistinct($.p.id) }))
			.where(($) => [$.orgId.eq(org)])
			.groupBy("email")
			.orderBy(["email", "asc"]),
	)

	// where: { posts: { some: { published: true } } }
	const published = PG.from(Posts)
		.select(($) => ({ author: $.authorEmail }))
		.where(($) => [$.orgId.eq(org), $.published.eq(true)])
	const withPublished = yield* Db.run(
		PG.from(Users)
			.select("email")
			.where(($) => [$.orgId.eq(org), PG.inSubquery($.email, published)]),
	)

	// JSON field: select profile->>'city'
	const cities = yield* Db.run(
		PG.from(Users)
			.select(($) => ({ email: $.email, city: PG.jsonText($.profile, "city") }))
			.where(($) => [$.orgId.eq(org)])
			.orderBy(["email", "asc"]),
	)

	// cursor pagination: findMany({ cursor: { email }, skip: 1, take: 1, orderBy: { email: "asc" } })
	const page = yield* Db.run(
		PG.from(Users)
			.select("email")
			.where(($) => [$.orgId.eq(org), $.email.gt("ada@example.com")])
			.orderBy(["email", "asc"])
			.limit(1),
	)

	// upsert
	yield* Db.run(
		PG.insertInto(Users)
			.values({ orgId: org, email: "bob@example.com", profile: { city: "Rome" } })
			.onConflictDoUpdate({
				target: ["email"],
				set: PG.excluded(["profile"]),
				// The target is not tenant-keyed, so pin the row it would update to this tenant.
				where: (existing) => existing.orgId.eq(org),
			}),
	)

	// updateMany, with @updatedAt written by hand
	const unpublished = yield* Db.run(
		PG.update(Posts)
			.set({ published: false })
			.where(($) => [$.orgId.eq(org), $.authorEmail.eq("ada@example.com")])
			.returning("id"),
	)
	yield* Db.run(
		PG.update(Users)
			.set(() => ({ updatedAt: PG.now() }))
			.where(($) => [$.orgId.eq(org), $.email.eq("bob@example.com")]),
	)

	// P2002: create with a taken email
	const duplicate = yield* Db.run(
		PG.insertInto(Users).values({ orgId: org, email: "ada@example.com", profile: { city: "Oslo" } }),
	).pipe(
		Effect.as("created" as const),
		Effect.catchTag("@maple-dev/effect-orm/DatabaseError", (error) =>
			error.reason === "UniqueViolation" ? Effect.succeed("taken" as const) : Effect.fail(error),
		),
	)

	// $transaction(async (tx) => ...) and delete
	yield* Effect.gen(function* () {
		yield* Db.run(PG.deleteFrom(Posts).where(($) => [$.orgId.eq(org), $.id.eq(2)]))
		yield* Db.run(PG.deleteFrom(Users).where(($) => [$.orgId.eq(org), $.email.eq("bob@example.com")]))
	}).pipe(Db.transaction())

	// $queryRaw
	const raw = yield* Db.query(
		Db.sql`SELECT count(*)::int AS n FROM users WHERE org_id = ${org}`,
		Schema.Struct({ n: Schema.Number }),
	)

	return {
		found: found?.email,
		insensitive: insensitive.map((row) => row.email),
		counts,
		withPublished: withPublished.map((row) => row.email),
		cities,
		page: page.map((row) => row.email),
		unpublished: unpublished.map((row) => row.id),
		duplicate,
		usersLeft: raw[0]?.n,
	}
})

const DatabaseLive = Db.layerSqlClient({ dialect: PG.postgresDialect, requireTenantScope: true }).pipe(
	Layer.provideMerge(PgliteClient.layer({ postgresqlconf: "timezone = 'UTC'" })),
)

export const result = await Effect.runPromise(program.pipe(Effect.provide(DatabaseLive)))
```

```ts
// result
{
	found: "ada@example.com",
	insensitive: ["ada@example.com", "bob@example.com"],
	counts: [{ email: "ada@example.com", posts: 2 }, { email: "bob@example.com", posts: 0 }],
	withPublished: ["ada@example.com"],
	cities: [{ email: "ada@example.com", city: "London" }, { email: "bob@example.com", city: "Paris" }],
	page: ["bob@example.com"],
	unpublished: [1, 2],
	duplicate: "taken",
	usersLeft: 1,
}
```

The posts join pins its tenant through `u.orgId.eq(p.orgId)` in the ON clause, so the query stays
single-tenant and a user without posts keeps a row. A filter on `p.orgId` in the WHERE would
drop that row, as it would in SQL.

## What is different by design

- **Effect services and Layers.** `Database` is a service. You build it with
  `Db.layerSqlClient` over any Effect `SqlClient` (`@effect/sql-pg`, `@effect/sql-pglite`,
  `@effect/sql-clickhouse`, `@effect/sql-sqlite-node`, `@effect/sql-d1`), and provide it once. A test swaps the client layer, not a mock.
- **Typed errors.** A failed statement is a `DatabaseError` with the driver's `reason` and the
  server's `sqlState`. COMMIT and ROLLBACK failures are their own errors. A helper marked
  `Db.requireTransaction` does not compile outside `Db.transaction`, so a missing transaction is
  a type error, not a runtime surprise.
- **Schema-decoded rows.** Each query derives a row Schema from its select list, and `Db.run`
  decodes every row with it. A `jsonb(schema)` column is checked on read, and a value the column
  type cannot hold fails with a decode error instead of reaching your code.
- **Tenant scope proof.** A table can declare its `tenantColumn`. Every compiled query then
  reports `single-tenant`, `cross-tenant` or `untenanted`, and `requireTenantScope` refuses a
  `cross-tenant` query unless it says so with `crossTenant()`. Prisma and Drizzle leave this to
  middleware or row-level security.
  See [Tenant scoping](./tenant-scoping.md).

## A CAFE Worker

CAFE is Cloudflare, Alchemy, Foldkit and Effect. A Worker can use D1 through `d1Dialect` and
`@effect/sql-d1` ([Execute on D1](./sqlite.md#execute-on-d1)), or reach Postgres through
[Hyperdrive](https://developers.cloudflare.com/hyperdrive/), as below. The handler below does not
know which client it runs on: it takes a function that builds a `Database` for each request.

```ts title="cafe-worker.ts"
import { Effect, Layer } from "effect"
import * as Db from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"

export const Tours = PG.table("tours", {
	columns: { id: PG.int4, orgId: PG.column(PG.text, { name: "org_id" }), unit: PG.text },
	primaryKey: ["id"],
	tenantColumn: "orgId",
})

// One request: read the org's tours. The org comes from the verified session in a real
// Worker; a header keeps the sketch short.
const listTours = (request: Request) =>
	Effect.gen(function* () {
		const org = request.headers.get("x-org-id")
		if (org === null) return new Response("missing org", { status: 401 })
		const tours = yield* Db.run(
			PG.from(Tours)
				.select("id", "unit")
				.where(($) => [$.orgId.eq(org)])
				.orderBy(["id", "asc"]),
		)
		return Response.json(tours)
	})

// The Worker's fetch handler. `database` builds a Database for one request: on Workers a
// connection must not outlive the request that opened it.
export const makeWorker = <Env>(database: (env: Env) => Layer.Layer<Db.Database, unknown>) => ({
	fetch: (request: Request, env: Env): Promise<Response> =>
		listTours(request).pipe(
			Effect.provide(database(env)),
			Effect.catchCause(() => Effect.succeed(new Response("database error", { status: 500 }))),
			Effect.runPromise,
		),
})
```

On Cloudflare, give it `@effect/sql-pg` over the Hyperdrive binding. The Worker needs the
`nodejs_compat` flag for the `pg` driver. This part is not typechecked here, because
`@effect/sql-pg` and the Workers types are not dependencies of this package:

```ts
import { PgClient } from "@effect/sql-pg"
import { Layer, Redacted } from "effect"
import * as Db from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"
import { makeWorker } from "./cafe-worker"

export default makeWorker((env: { readonly HYPERDRIVE: Hyperdrive }) =>
	Db.layerSqlClient({ dialect: PG.postgresDialect, requireTenantScope: true }).pipe(
		Layer.provide(PgClient.layer({ url: Redacted.make(env.HYPERDRIVE.connectionString) })),
	),
)
```

The same handler runs locally on PGlite, with no network:

```ts title="cafe-worker-local.ts"
import { PGlite } from "@electric-sql/pglite"
import { PgliteClient } from "@effect/sql-pglite"
import { Layer } from "effect"
import * as Db from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"
import { makeWorker } from "./cafe-worker"

// One PGlite instance plays the database behind Hyperdrive. Each request opens its own
// client on it, as the Worker does with the Hyperdrive connection string.
const origin = new PGlite()
await origin.exec(`
	CREATE TABLE tours (id int4 PRIMARY KEY, org_id text NOT NULL, unit text NOT NULL);
	INSERT INTO tours VALUES (1, 'org_1', '4B'), (2, 'org_2', '7A'), (3, 'org_1', '2C');
`)

const worker = makeWorker((env: { readonly origin: PGlite }) =>
	Db.layerSqlClient({ dialect: PG.postgresDialect, requireTenantScope: true }).pipe(
		Layer.provide(PgliteClient.layer({ liveClient: env.origin })),
	),
)

const get = (headers: Record<string, string>) =>
	worker.fetch(new Request("https://cafe.example/tours", { headers }), { origin })

export const org1 = await (await get({ "x-org-id": "org_1" })).json()
// [{ id: 1, unit: "4B" }, { id: 3, unit: "2C" }]
export const anonymous = (await get({})).status
// 401
await origin.close()
```

The Alchemy stack (`alchemy.run.ts` with the Worker and its Hyperdrive or D1 binding), Durable
Object SQLite storage and a Foldkit UI are not in this guide yet.

// Type-level tests: the seeded row type, and which overrides a column takes.

import { Arbitrary, type DateTime, Effect, Schema } from "effect"
import { expectTypeOf } from "expect-type"
import * as PG from "../postgres"
import * as Db from "../database"
import * as Seed from "../seed"

const OrgId = Schema.String.pipe(Schema.brand("OrgId"))
type OrgId = typeof OrgId.Type

const Users = PG.table("users", {
	columns: {
		id: PG.int4,
		org_id: PG.brand(PG.text, OrgId),
		bio: PG.nullable(PG.text),
		created_at: PG.column(PG.timestamptz, { defaultExpr: "now()" }),
	},
	primaryKey: ["id"],
	tenantColumn: "org_id",
})

// Every column, decoded; a defaulted column is optional.
type Row = Seed.SeedRowOf<typeof Users>
expectTypeOf<Row["id"]>().toEqualTypeOf<number>()
expectTypeOf<Row["org_id"]>().toEqualTypeOf<OrgId>()
expectTypeOf<Row["bio"]>().toEqualTypeOf<string | null>()
expectTypeOf<Pick<Row, "created_at">>().toEqualTypeOf<{ readonly created_at?: DateTime.Utc }>()

expectTypeOf(Seed.rows(Users, { count: 1, tenant: OrgId.make("o") })).toEqualTypeOf<
	Effect.Effect<ReadonlyArray<Row>, Seed.SeedError>
>()
expectTypeOf(Seed.insert(Users, { count: 1, tenant: OrgId.make("o") })).toEqualTypeOf<
	Effect.Effect<ReadonlyArray<Row>, Seed.SeedError | Db.DatabaseError | PG.QueryBuilderError | PG.CompiledQueryDecodeError, Db.Database>
>()
expectTypeOf(Seed.arbitrary(Users)).toEqualTypeOf<Effect.Effect<Arbitrary.Arbitrary<Row>, Seed.SeedError>>()

// An override is a value, an Arbitrary or a function of the index, of the column's type.
Seed.rows(Users, { count: 1, columns: { id: 1, bio: null } })
Seed.rows(Users, { count: 1, columns: { id: Seed.pick([1, 2]), bio: (i) => `bio ${i}` } })
// @ts-expect-error -- a string is not an int4
Seed.rows(Users, { count: 1, columns: { id: "1" } })
// @ts-expect-error -- a plain string is not an OrgId
Seed.rows(Users, { count: 1, columns: { org_id: "o" } })
// @ts-expect-error -- not a column
Seed.rows(Users, { count: 1, columns: { nope: 1 } })
// @ts-expect-error -- `unique` names columns
Seed.rows(Users, { count: 1, unique: ["nope"] })
// @ts-expect-error -- the Arbitrary form has no row index
Seed.arbitrary(Users, { columns: { id: (i: number) => i } })

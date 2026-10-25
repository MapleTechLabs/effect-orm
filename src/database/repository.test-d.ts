// Type-level tests: what a repository's methods take and return

import type { Effect, Option } from "effect"
import { expectTypeOf } from "expect-type"
import * as PG from "../postgres"
import * as Db from "../database"

const Tickets = PG.table("tickets", {
	columns: {
		id: PG.column(PG.int4, { identity: "always" }),
		org: PG.text,
		title: PG.text,
		note: PG.nullable(PG.text),
	},
	primaryKey: ["id"],
	tenantColumn: "org",
})
type Ticket = PG.SelectRowOf<typeof Tickets>

declare const tickets: Effect.Success<ReturnType<typeof makeTickets>>
const makeTickets = () => Db.makeRepository(Tickets, { idColumn: "id", tenantColumn: "org" })

// It needs the Database in context, and fails with nothing when it is built.
// Inserts take the insert row without the tenant column; patches the update row without the id
// and the tenant column.
expectTypeOf(makeTickets()).toEqualTypeOf<
	Effect.Effect<
		Db.TenantRepository<
			Ticket,
			string,
			number,
			{ readonly id?: number | undefined; readonly title: string; readonly note?: string | null | undefined },
			{ readonly title?: string | undefined; readonly note?: string | null | undefined }
		>,
		never,
		Db.Database
	>
>()

// Every method takes the tenant first.
expectTypeOf(tickets.findById("acme", 1)).toEqualTypeOf<Effect.Effect<Option.Option<Ticket>, Db.RepositoryError>>()
expectTypeOf(tickets.insert("acme", { title: "t" })).toEqualTypeOf<Effect.Effect<Ticket, Db.RepositoryError>>()
// @ts-expect-error -- no tenant: a read that is not pinned to one does not compile
tickets.findById(1)
// @ts-expect-error -- no tenant
tickets.delete(1)
// @ts-expect-error -- the tenant comes from the argument, not the row
tickets.insert("acme", { title: "t", org: "other" })
// @ts-expect-error -- an update cannot move a row to another tenant
tickets.update("acme", 1, { org: "other" })
// @ts-expect-error -- nor change its id
tickets.updateVoid("acme", 1, { id: 2 })
// @ts-expect-error -- a required column of the insert row is still required
tickets.insertVoid("acme", {})
// @ts-expect-error -- the id has the id column's type
tickets.findById("acme", "1")

// A table without a tenant column: no tenant argument.
const Tags = PG.table("tags", { columns: { name: PG.text, uses: PG.int4 }, primaryKey: ["name"] })
declare const tags: Effect.Success<ReturnType<typeof makeTags>>
const makeTags = () => Db.makeRepository(Tags, { idColumn: "name" })
expectTypeOf(tags.findById("urgent")).toEqualTypeOf<
	Effect.Effect<Option.Option<{ readonly name: string; readonly uses: number }>, Db.RepositoryError>
>()
expectTypeOf(tags.update).parameters.toEqualTypeOf<[string, { readonly uses?: number | undefined }]>()

// @ts-expect-error -- the id column must be a column
Db.makeRepository(Tags, { idColumn: "nope" })
// @ts-expect-error -- the tenant column cannot also be the id
Db.makeRepository(Tickets, { idColumn: "org", tenantColumn: "org" })

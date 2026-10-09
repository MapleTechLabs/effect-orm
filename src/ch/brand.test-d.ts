// Branded columns are strict: a brand is the claim that a value is one kind of
// id and not another, so everything that writes or compares a branded column
// has to hold that brand.

import { DateTime, Schema } from "effect"
import { expectTypeOf } from "vitest"
import * as CH from "./index"
import * as PG from "../postgres"
import * as S from "../schema"
import type { RowOf } from "../database"

const OrgId = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand("@maple/OrgId"))
type OrgId = typeof OrgId.Type
const UserId = Schema.String.pipe(Schema.brand("@maple/UserId"))
type UserId = typeof UserId.Type
const Cents = Schema.Number.pipe(Schema.brand("Cents"))
type Cents = typeof Cents.Type
const Status = Schema.Literals(["open", "closed"])

const orgId = PG.brand(PG.text, OrgId)
const userId = PG.brand(PG.text, UserId)

const Dashboards = PG.table("dashboards", {
	columns: {
		org_id: orgId,
		id: PG.text,
		owner: PG.nullable(userId),
		editors: PG.array(userId),
		budget: PG.brand(PG.int8, Cents),
		status: PG.column(PG.brand(PG.text, Status), { default: "open" }),
		created_at: PG.timestamptz,
	},
	primaryKey: ["org_id", "id"],
})
const Plain = CH.table("plain", { org_id: PG.text })

declare const org: OrgId
declare const user: UserId

// Rows carry the brands, through nullable and array.
expectTypeOf<CH.SelectRowOf<typeof Dashboards>>().toEqualTypeOf<{
	readonly org_id: OrgId
	readonly id: string
	readonly owner: UserId | null
	readonly editors: ReadonlyArray<UserId>
	readonly budget: Cents
	readonly status: "open" | "closed"
	readonly created_at: DateTime.Utc
}>()
const selected = CH.from(Dashboards).select("org_id", "owner")
expectTypeOf<RowOf<typeof selected>>().toEqualTypeOf<{ readonly org_id: OrgId; readonly owner: UserId | null }>()

// Comparisons take the brand: a value, a branded column, or a param of the type.
CH.from(Dashboards).select("id").where(($) => [
	$.org_id.eq(org),
	$.org_id.eq(CH.param.of(orgId, "orgId")),
	$.owner.eq(user),
	$.org_id.in_(org, org),
	$.budget.gt(Cents.make(100)),
])
CH.from(Dashboards)
	.innerJoin(Dashboards, "d2", (main, joined) => main.org_id.eq(joined.org_id))
	.select("id")
// @ts-expect-error a plain string is not an OrgId
CH.from(Dashboards).select("id").where(($) => [$.org_id.eq("org_1")])
// @ts-expect-error a UserId is not an OrgId: the mistake brands exist to catch
CH.from(Dashboards).select("id").where(($) => [$.org_id.eq(user)])
// @ts-expect-error param.string is a plain string
CH.from(Dashboards).select("id").where(($) => [$.org_id.eq(CH.param.string("orgId"))])
// @ts-expect-error nor in a list
CH.from(Dashboards).select("id").where(($) => [$.org_id.in_("a", "b")])
// @ts-expect-error a plain number is not Cents
CH.from(Dashboards).select("id").where(($) => [$.budget.gt(100)])
// @ts-expect-error a plain-string column is not an OrgId column
CH.from(Dashboards).innerJoin(Plain, "p", (main, joined) => main.org_id.eq(joined.org_id)).select("id")

// A literal union compares against its own members, or a param of its primitive checked by the server.
CH.from(Dashboards).select("id").where(($) => [$.status.eq("open"), $.status.eq(CH.param.string("s"))])
// @ts-expect-error not a member of the union
CH.from(Dashboards).select("id").where(($) => [$.status.eq("opne")])
// @ts-expect-error nor in a list
CH.from(Dashboards).select("id").where(($) => [$.status.in_("open", "opne")])
// String operators still work on a branded string.
CH.from(Dashboards).select("id").where(($) => [$.org_id.like("org_%")])

// The param's value is the brand too.
const byOrg = CH.from(Dashboards)
	.select("id")
	.where(($) => [$.org_id.eq(CH.param.of(orgId, "orgId"))])
PG.compileUnsafe(byOrg, { orgId: org })
// @ts-expect-error the param wants an OrgId
PG.compileUnsafe(byOrg, { orgId: "org_1" })

// Inserts and updates take the brand.
CH.insertInto(Dashboards).values({ org_id: org, id: "d", editors: [user], budget: Cents.make(0), created_at: new Date() })
CH.insertInto(Dashboards).values({
	// @ts-expect-error a plain string is not an OrgId
	org_id: "o",
	id: "d",
	editors: [],
	budget: Cents.make(0),
	created_at: new Date(),
})
CH.update(Dashboards)
	.set({ owner: user })
	.where(($) => [$.org_id.eq(org)])
CH.update(Dashboards)
	// @ts-expect-error an OrgId is not a UserId
	.set({ owner: org })
	.where(($) => [$.org_id.eq(org)])

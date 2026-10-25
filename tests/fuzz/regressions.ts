// Pinned counterexamples, replayed before any random input.
//
// When a property fails, its report prints the shrunk input; paste it here under
// a key that is a substring of the property's name (so one plan can pin every
// target at once). Inputs that hit an open entry in `known-issues.ts` are
// skipped until the bug is fixed, then replayed for good.
import { DateTime } from "effect"
import type { Plan, RowsShape, UnionPlan } from "./plan"

const rows = (shape: RowsShape): Plan => ({ orgId: "org_1", join: undefined, where: [], shape, wrap: false, crossTenant: false })

export const pinned: Record<string, ReadonlyArray<unknown>> = {
	// Every plan property: "plans compile cleanly" and "plans match the model".
	plans: [
		// Documented: a chain follows SQL precedence, `Id + 0 * 2`. The model must agree.
		rows({
			k: "rows",
			select: [["id", { k: "col", col: "Id" }], ["e0", { k: "arith", op: "mul", l: { k: "arith", op: "add", l: { k: "col", col: "Id" }, r: { k: "num", v: 0 } }, r: 2 }]],
			distinct: false,
			orderBy: [],
		}),
		// arith-argument-not-parenthesised: `Id - Amount + 1`.
		rows({
			k: "rows",
			select: [["id", { k: "col", col: "Id" }], ["e0", { k: "arith", op: "sub", l: { k: "col", col: "Id" }, r: { k: "arith", op: "add", l: { k: "col", col: "Amount" }, r: 1 } }]],
			distinct: false,
			orderBy: [],
		}),
		// fromquery-select-all.
		{ ...rows({ k: "rows", select: [["id", { k: "col", col: "Id" }]], distinct: false, orderBy: [] }), wrap: "all" },
		// clickhouse-server-and-absorption.
		{
			...rows({ k: "rows", select: [["id", { k: "col", col: "Id" }]], distinct: false, orderBy: [] }),
			where: [
				{ k: "tenant", side: "orders" },
				{ k: "or", style: "method", cs: [{ k: "and", style: "method", cs: [{ k: "const", v: true }, { k: "tenant", side: "orders" }] }, { k: "tenant", side: "orders" }] },
			],
		},
		// `OrgId IN ('org_2')` pins the query to org_2, not to the orgId param: single-tenant, and right to read org_2.
		{
			...rows({ k: "rows", select: [["id", { k: "col", col: "Id" }]], distinct: false, orderBy: [] }),
			where: [{ k: "in", neg: false, e: { k: "col", col: "OrgId" }, values: ["org_2"] }],
		},
		// pg-fraction-bound-to-integer.
		{
			...rows({ k: "rows", select: [["id", { k: "col", col: "Id" }]], distinct: false, orderBy: [] }),
			where: [{ k: "cmp", op: "gt", l: { k: "col", col: "Amount" }, r: { k: "value", v: 9.75 } }],
		},
	] satisfies ReadonlyArray<Plan>,

	// Literals.
	"clickhouse:Float64": [5e-324, -5e-324, 44812297868494010, 2.1722934738885276e269],
	"clickhouse:Array(Nullable(Int64)) compare": [[0, 4294967296]],
	"clickhouse:String": ["__PARAM_string_x__", "\\'", "\0"],
	"postgres:boolean select": [false],
	"postgres:text[] select": [[]],
	"postgres:timestamptz": [DateTime.makeUnsafe(Date.UTC(100, 0, 1))],

	// Unions.
	"unions match the model": [
		// clickhouse-union-variant-order-by: `Id + 1` (UInt64) under `Id + -1` (Int64), ordered by that column.
		{
			orgId: "org_1",
			branches: [
				rows({ k: "rows", select: [["id", { k: "col", col: "Id" }], ["e0", { k: "arith", op: "add", l: { k: "col", col: "Id" }, r: 1 }]], distinct: false, orderBy: [] }),
				rows({ k: "rows", select: [["id", { k: "col", col: "Id" }], ["e0", { k: "arith", op: "add", l: { k: "col", col: "Id" }, r: -1 }]], distinct: false, orderBy: [] }),
			],
			orderBy: [["e0", "asc"], ["id", "asc"]],
			crossTenant: false,
		},
	] satisfies ReadonlyArray<UnionPlan>,

	// Hostile values.
	"hostile values are refused, never thrown (clickhouse)": [
		{ dialect: "clickhouse", column: "OrgId", site: "eq", value: 0n },
		{ dialect: "clickhouse", column: "OrgId", site: "like", value: {} },
		{ dialect: "clickhouse", column: "OrgId", site: "select", value: Number.NaN },
		{ dialect: "clickhouse", column: "OrgId", site: "lit", value: 0n },
		{ dialect: "clickhouse", column: "OrgId", site: "add", value: undefined },
		{ dialect: "clickhouse", column: "OrgId", site: "add", value: new Date(Number.NaN) },
	],
	"hostile values are refused, never thrown (postgres)": [
		{ dialect: "postgres", column: "OrgId", site: "param.dateTime", value: "" },
		{ dialect: "postgres", column: "Created", site: "param.of", value: "2026-13-45 99:99:99" },
	],
}

/** Every pinned input whose key appears in `property`'s name. */
export const pinnedFor = (property: string): ReadonlyArray<unknown> =>
	Object.entries(pinned).flatMap(([key, inputs]) => (property.includes(key) ? inputs : []))

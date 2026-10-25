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
		// sqlite-like-no-default-escape: `\_` was a literal backslash on SQLite.
		{
			orgId: "org_2",
			join: "left",
			where: [{ k: "tenant", side: "orders" }],
			shape: { k: "agg", keys: [], aggs: [["a0", { k: "countIf", c: { k: "like", op: "like", l: { k: "jcol", col: "OrgId" }, pattern: "org\\__" } }]], having: [], orderBy: [] },
			wrap: false,
			crossTenant: false,
		},
		// `OrgId IN ('org_2')` pins the query to org_2, not to the orgId param: single-tenant, and right to read org_2.
		{
			...rows({ k: "rows", select: [["id", { k: "col", col: "Id" }]], distinct: false, orderBy: [] }),
			where: [{ k: "in", neg: false, e: { k: "col", col: "OrgId" }, values: ["org_2"] }],
		},
		// pg-fraction-bound-to-integer, and sqlite-integer-refuses-fraction.
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
	// SQLite reads these decimals as a neighbouring double, as a literal or through json_extract.
	":real ": [1.23456789e-95, 5.464465248610941e-277, -1.415281131826549e-267, 0, 5e-324],
	"postgres:text[] select": [[]],
	"postgres:timestamptz": [DateTime.makeUnsafe(Date.UTC(100, 0, 1))],

	// SQLite migrations.
	"migrations reach": [
		// sqlite-rebuild-no-shared-column: a rebuild keeping no column copied no rows.
		[
			[{ name: "t0", columns: [{ name: "c2", type: "text", nullable: false, unique: true }], primaryKey: [], indexes: [] }],
			[{ name: "t0", columns: [{ name: "c0", type: "blob", nullable: true, unique: false }], primaryKey: [], indexes: [] }],
			1,
			[false],
		],
		// sqlite-drop-last-column: replacing every column dropped the last one before adding.
		[
			[{ name: "t0", columns: [{ name: "c1", type: "text", nullable: false, default: { k: "expr" }, unique: false }, { name: "c2", type: "text", nullable: false, unique: false }], primaryKey: [], indexes: [] }],
			[{ name: "t0", columns: [{ name: "c3", type: "text", nullable: true, unique: false }], primaryKey: [], indexes: [] }],
			0,
			[false],
		],
		// A column made NOT NULL with a default over old NULLs (COALESCE in the copy).
		[
			[{ name: "t0", columns: [{ name: "c0", type: "text", nullable: false, unique: false }, { name: "c1", type: "text", nullable: true, unique: false }], primaryKey: [], indexes: [] }],
			[{ name: "t0", columns: [{ name: "c0", type: "text", nullable: false, unique: false }, { name: "c1", type: "text", nullable: false, default: { k: "literal" }, unique: false }], primaryKey: [], indexes: [] }],
			2,
			[true],
		],
	],

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
	// A Date before year 0 reached a timestamp encoder that threw instead of failing.
	"hostile values are refused, never thrown (sqlite)": [{ dialect: "sqlite", column: "Created", site: "gt", value: new Date("-000001-12-31T23:59:59.999Z") }],
	"hostile values are refused, never thrown (postgres)": [
		{ dialect: "postgres", column: "OrgId", site: "param.dateTime", value: "" },
		{ dialect: "postgres", column: "Created", site: "param.of", value: "2026-13-45 99:99:99" },
	],
}

/** Every pinned input whose key appears in `property`'s name. */
export const pinnedFor = (property: string): ReadonlyArray<unknown> =>
	Object.entries(pinned).flatMap(([key, inputs]) => (property.includes(key) ? inputs : []))

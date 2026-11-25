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
		// The same server bug in a shape the old matcher missed (ClickHouse 26.2): `(a OR 0 OR a) AND (a OR 0)`.
		{
			...rows({ k: "rows", select: [["id", { k: "col", col: "Id" }]], distinct: false, orderBy: [] }),
			orgId: "org_3",
			where: [
				{
					k: "and",
					style: "method",
					cs: [
						{ k: "or", style: "method", cs: [{ k: "null", op: "isNotNull", e: { k: "col", col: "Note" } }, { k: "const", v: false }, { k: "null", op: "isNotNull", e: { k: "col", col: "Note" } }] },
						{ k: "or", style: "method", cs: [{ k: "null", op: "isNotNull", e: { k: "col", col: "Note" } }, { k: "in", neg: false, e: { k: "str", v: "" }, values: [] }] },
					],
				},
			],
		},
		// A ClickHouse server bug (a one-argument and()): run again without the rewrite, rows still checked (dialects/clickhouse.ts).
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
		// mysql-prepared-fraction-after-parameter-constant-column: `OrgId = ? AND Id = ?` with ['org_1', 0.75] matched Id 1 on MySQL 8.4.
		{
			...rows({ k: "rows", select: [["id", { k: "col", col: "Id" }]], distinct: false, orderBy: [] }),
			where: [{ k: "tenant", side: "orders" }, { k: "between", neg: false, e: { k: "col", col: "Id" }, lo: { k: "value", v: 0.25 }, hi: { k: "value", v: 0.75 } }],
		},
		{
			...rows({ k: "rows", select: [["id", { k: "col", col: "Id" }]], distinct: false, orderBy: [] }),
			where: [{ k: "tenant", side: "orders" }, { k: "cmp", op: "eq", l: { k: "col", col: "Id" }, r: { k: "value", v: 0.75 } }],
		},
		// clickhouse-26.2-empty-like-match-all, over a pattern computed per row: an unmatched LEFT JOIN row's `''` contains itself.
		{
			orgId: "org_3",
			join: "left",
			where: [],
			shape: { k: "agg", keys: [], aggs: [["a0", { k: "countIf", c: { k: "match", op: "contains", l: { k: "jcol", col: "OrgId" }, needle: { k: "expr", e: { k: "jcol", col: "OrgId" } }, insensitive: false } }]], having: [], orderBy: [] },
			wrap: false,
			crossTenant: true,
		},
		// An empty literal against a column that is empty on the unmatched LEFT JOIN rows: `'' LIKE '%%'` row by row, until the builder wrote `c.Tier = ''`.
		{
			orgId: "org_1",
			join: "left",
			where: [{ k: "match", op: "contains", l: { k: "str", v: "" }, needle: { k: "expr", e: { k: "jcol", col: "Tier" } }, insensitive: false }],
			shape: { k: "rows", select: [["id", { k: "col", col: "Id" }]], distinct: false, orderBy: [] },
			wrap: false,
			crossTenant: true,
		},
		// A literal on the left of a pattern read from a column: 26.2 refused it until the builder wrote `materialize('a')`.
		{
			...rows({ k: "rows", select: [["id", { k: "col", col: "Id" }]], distinct: false, orderBy: [] }),
			where: [{ k: "match", op: "contains", l: { k: "str", v: "a" }, needle: { k: "expr", e: { k: "col", col: "OrgId" } }, insensitive: false }],
		},
		// The same with an empty literal and an empty param: `'' LIKE '%%'` as a constant, false on 26.2.
		{
			...rows({ k: "rows", select: [["id", { k: "col", col: "Id" }]], distinct: false, orderBy: [] }),
			where: [{ k: "match", op: "contains", l: { k: "str", v: "" }, needle: { k: "param", kind: "string", v: "" }, insensitive: false }],
		},
		// clickhouse-26.2-empty-like-match-all: `'' LIKE '%%'` is false on 26.2.19.43, so the count was 0.
		{
			orgId: "org_1",
			join: "inner",
			where: [{ k: "like", op: "like", l: { k: "str", v: "" }, pattern: "%%" }],
			shape: { k: "agg", keys: [], aggs: [["a0", { k: "count" }]], having: [], orderBy: [] },
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
		// mysql-order-by-integer-alias: MySQL 8.4 merges a derived table and reads `10 AS e1 … ORDER BY e1`
		// as ORDER BY position 10 (unknown column), and `1 AS e1` as the first column, silently.
		{
			...rows({
				k: "rows",
				select: [["id", { k: "col", col: "Id" }], ["e0", { k: "num", v: 1 }], ["e1", { k: "num", v: 10 }]],
				distinct: false,
				orderBy: [["e0", "asc"], ["e1", "asc"], ["id", "desc"]],
			}),
			wrap: "all",
		},
		// clickhouse-26.2-left-join-like-match-all: the unmatched order (initech) matches `'' LIKE '%%'` and stays.
		{
			...rows({ k: "rows", select: [["id", { k: "col", col: "Id" }]], distinct: false, orderBy: [] }),
			orgId: "org_3",
			join: "left",
			where: [{ k: "like", op: "like", l: { k: "jcol", col: "OrgId" }, pattern: "%%" }],
		},
		// mysql-prepared-between-constant-column: 99 is not between 0 and 98.75.
		{
			...rows({ k: "rows", select: [["id", { k: "col", col: "Id" }]], distinct: false, orderBy: [] }),
			join: "left",
			where: [{ k: "between", neg: false, e: { k: "col", col: "Amount" }, lo: { k: "value", v: 0 }, hi: { k: "value", v: 98.75 } }],
		},
	] satisfies ReadonlyArray<Plan>,

	// Only where a string literal may hold a NUL: Postgres and SQLite text cannot.
	"plans match the model (clickhouse": [
		// clickhouse-26.2-like-suffix-nul: `'org_1' LIKE '%\0'` is true on 26.2.19.43.
		{
			orgId: "org_1",
			join: "inner",
			where: [{ k: "tenant", side: "orders" }, { k: "match", op: "endsWith", l: { k: "str", v: "org_1" }, needle: { k: "value", v: "\0" }, insensitive: false }],
			shape: { k: "agg", keys: [], aggs: [["a0", { k: "count" }]], having: [], orderBy: [] },
			wrap: false,
			crossTenant: false,
		},
	],
	// ClickHouse 26.2 must page a DISTINCT query over generated rows correctly.
	"generated fixtures: query results agree": [{
		// MySQL truncates a quotient at whole 9-digit words: `99 % ((94 / 44) / -2)` is 0.72727274, not …73.
		fixture: { orders: [{ OrgId: "org_1", Id: 1, Customer: "acme", Amount: 0, Status: "paid", Note: null, Created: Date.UTC(2026, 0, 1) }], customers: [] },
		plan: rows({
			k: "rows",
			select: [["id", { k: "col", col: "Id" }], ["e0", { k: "arith", op: "mod", l: { k: "num", v: 99 }, r: { k: "arith", op: "div", l: { k: "arith", op: "div", l: { k: "num", v: 94 }, r: { k: "num", v: 44 } }, r: -2 } }]],
			distinct: false,
			orderBy: [],
		}),
	}, {
		fixture: {
			orders: [1, 2].map((Id) => ({ OrgId: "org_1", Id, Customer: "acme", Amount: 0, Status: "paid", Note: null, Created: Date.UTC(2026, 0, 1) })),
			customers: [],
		},
		plan: rows({ k: "rows", select: [["id", { k: "col", col: "Id" }]], distinct: true, orderBy: [["id", "asc"]], offset: 1 }),
	}, {
		// An empty ClickHouse source must not fold `Id % Id` over constant placeholder columns.
		fixture: { orders: [], customers: [] },
		plan: {
			orgId: "org_1", join: undefined, where: [], wrap: false, crossTenant: false,
			shape: {
				k: "agg", keys: [["k0", { k: "col", col: "Status" }]], aggs: [["a0", { k: "count" }]], orderBy: [],
				having: [{ agg: { k: "sum", e: { k: "arith", op: "mod", l: { k: "col", col: "Id" }, r: { k: "col", col: "Id" } } }, op: "eq", v: 0 }],
			},
		},
	}],

	// Literals.
	"clickhouse:Float64": [5e-324, -5e-324, 44812297868494010, 2.1722934738885276e269],
	"clickhouse:Array(Nullable(Int64)) compare": [[0, 4294967296]],
	"clickhouse:String": ["__PARAM_string_x__", "\\'", "\0"],
	"postgres:boolean select": [false],
	"postgres:float4 ": [Math.fround(0.1), 2 ** -149, -(2 ** -149), Math.fround(3.4028234663852886e38)],
	// SQLite reads these decimals as a neighbouring double, as a literal or through json_extract.
	":real ": [1.23456789e-95, 5.464465248610941e-277, -1.415281131826549e-267, 0, 5e-324],
	"postgres:text[] select": [[]],
	"postgres:timestamptz ": [DateTime.makeUnsafe(Date.UTC(100, 0, 1))],

	// Timestamp years 0 and 99 must survive without Date.UTC's two-digit-year coercion.
	"sqlite:timestamp ": [DateTime.makeUnsafe("0000-01-01T00:00:00.000Z"), DateTime.makeUnsafe("0099-12-31T23:59:59.999Z")],
	"d1:timestamp ": [DateTime.makeUnsafe("0000-01-01T00:00:00.000Z"), DateTime.makeUnsafe("0099-12-31T23:59:59.999Z")],

	// Schema-derived JSON keeps explicit SQL escaping and nested-value regressions.
	"postgres:jsonb ": [{ message: "__PARAM_string_x__\\'", values: [null, -0, 5e-324], meta: { active: false, tags: ["it's", "😀"] } }],
	"sqlite:json ": [{ message: "__PARAM_string_x__\\'\0", values: [null, 1], meta: { active: true, tags: ["it's", "😀"] } }],
	"d1:json ": [{ message: "__PARAM_string_x__\\'\0", values: [null, 1], meta: { active: true, tags: ["it's", "😀"] } }],

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

	// MySQL and MariaDB migrations.
	"schema changes match a fresh create": [
		// mariadb-json-check-keeps-old-name: RENAME COLUMN left a JSON column's CHECK (json_valid(...))
		// named after the old column on MariaDB, where a fresh create names it after the new one.
		[
			[{ name: "t0", columns: [{ name: "c3", type: "int", nullable: false, unique: true }, { name: "c2", type: "int", nullable: false, unique: true }, { name: "c0", type: "json", nullable: false, default: { k: "literal" }, unique: false }], primaryKey: [], indexes: [] }],
			[
				{ name: "t0", columns: [{ name: "c2", type: "int", nullable: false, unique: true }, { name: "c1", type: "int", nullable: false, unique: true }, { name: "c0", type: "json", nullable: false, default: { k: "literal" }, unique: false }], primaryKey: [], indexes: [] },
				{ name: "t1", columns: [{ name: "c3", type: "int", nullable: false, unique: true }], primaryKey: [], indexes: [] },
			],
			0,
			[false],
			{ table: false, column: 51637149, caseOnly: false },
			{ text: "", int: 0, bigint: -9007199254740991, double: 0, cents: 0, at: 0 },
		],
	],

	// Unions.
	// MariaDB computes a branch with LIMIT (or DISTINCT) as a derived table at its own scale, then pads it
	// to the union's: `Id + 2 / 6` is 1.33330000 there and 1.33333333 on MySQL (`Semantics.unionDecimals`).
	"generated fixtures: union results agree": [{
		fixture: { orders: [{ OrgId: "org_1", Id: 1, Customer: "acme", Amount: 0, Status: "paid", Note: null, Created: Date.UTC(2026, 0, 1) }], customers: [] },
		plan: {
			orgId: "org_1",
			branches: [
				rows({ k: "rows", select: [["id", { k: "col", col: "Id" }], ["e0", { k: "arith", op: "add", l: { k: "col", col: "Id" }, r: { k: "arith", op: "div", l: { k: "num", v: 2 }, r: 6 } }]], distinct: false, orderBy: [["id", "asc"]], limit: 1 }),
				rows({ k: "rows", select: [["id", { k: "col", col: "Id" }], ["e0", { k: "arith", op: "div", l: { k: "arith", op: "div", l: { k: "num", v: 0 }, r: -1 }, r: 1 }]], distinct: false, orderBy: [] }),
			],
			orderBy: [["e0", "asc"]],
			crossTenant: true,
		} satisfies UnionPlan,
	}],
	"unions match the model": [
		// MySQL computes a DISTINCT branch first, at its own scale: `Id / (Id + 1)` is 0.66670000 beside the scale-8 `Id / 1 / 1`.
		{
			orgId: "org_1",
			branches: [
				rows({ k: "rows", select: [["id", { k: "col", col: "Id" }], ["e0", { k: "arith", op: "div", l: { k: "col", col: "Id" }, r: { k: "arith", op: "add", l: { k: "col", col: "Id" }, r: 1 } }]], distinct: true, orderBy: [] }),
				rows({ k: "rows", select: [["id", { k: "col", col: "Id" }], ["e0", { k: "arith", op: "div", l: { k: "arith", op: "div", l: { k: "col", col: "Id" }, r: 1 }, r: 1 }]], distinct: false, orderBy: [] }),
			],
			orderBy: [],
			crossTenant: true,
		},
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
		// An argument chain under DECIMAL division: `6 * ((5 - 2) / Id)` is 9 where Id = 2, not `6 * (5 - 2 / Id)`.
		{
			orgId: "org_1",
			branches: [
				rows({ k: "rows", select: [["id", { k: "col", col: "Id" }], ["e0", { k: "arith", op: "mul", l: { k: "num", v: 6 }, r: { k: "arith", op: "div", l: { k: "arith", op: "sub", l: { k: "num", v: 5 }, r: { k: "num", v: 2 } }, r: { k: "col", col: "Id" } } }]], distinct: false, orderBy: [] }),
				rows({ k: "rows", select: [["id", { k: "col", col: "Id" }], ["e0", { k: "arith", op: "div", l: { k: "num", v: 38 }, r: { k: "num", v: 10 } }]], distinct: false, orderBy: [] }),
			],
			orderBy: [["e0", "asc"], ["id", "asc"]],
			crossTenant: false,
		},
		// MariaDB sized the integer literal a digit short beside a DECIMAL(5,4): 97 came back 9.9999 (mariadbDialect's `widen`).
		{
			orgId: "org_1",
			branches: [
				rows({ k: "rows", select: [["id", { k: "col", col: "Id" }], ["e0", { k: "num", v: 97 }]], distinct: false, orderBy: [] }),
				rows({ k: "rows", select: [["id", { k: "col", col: "Id" }], ["e0", { k: "arith", op: "div", l: { k: "num", v: 1 }, r: { k: "arith", op: "mul", l: { k: "num", v: 8 }, r: { k: "col", col: "Id" } } }]], distinct: false, orderBy: [] }),
			],
			orderBy: [],
			crossTenant: false,
		},
		{
			orgId: "org_1",
			branches: [
				rows({ k: "rows", select: [["id", { k: "col", col: "Id" }], ["e0", { k: "arith", op: "div", l: { k: "num", v: 0 }, r: 1 }]], distinct: false, orderBy: [] }),
				rows({ k: "rows", select: [["id", { k: "col", col: "Id" }], ["e0", { k: "num", v: 105 }]], distinct: false, orderBy: [] }),
			],
			orderBy: [],
			crossTenant: false,
		},
		// A UNION's DECIMAL column takes the widest scale: `14 / 3` is 4.66666667 beside `0 / -1 / 1`, not 4.6667 (model.ts `unionScales`).
		{
			orgId: "org_1",
			branches: [
				rows({ k: "rows", select: [["id", { k: "col", col: "Id" }], ["e0", { k: "arith", op: "div", l: { k: "arith", op: "div", l: { k: "num", v: 0 }, r: -1 }, r: 1 }]], distinct: false, orderBy: [] }),
				rows({ k: "rows", select: [["id", { k: "col", col: "Id" }], ["e0", { k: "arith", op: "div", l: { k: "num", v: 14 }, r: { k: "num", v: 3 } }]], distinct: false, orderBy: [] }),
				rows({ k: "rows", select: [["id", { k: "col", col: "Id" }], ["e0", { k: "arith", op: "sub", l: { k: "arith", op: "div", l: { k: "num", v: 4 }, r: { k: "col", col: "Amount" } }, r: { k: "arith", op: "add", l: { k: "num", v: 0 }, r: 8 } }]], distinct: false, orderBy: [] }),
			],
			orderBy: [["id", "asc"], ["e0", "asc"]],
			crossTenant: true,
		},
	] satisfies ReadonlyArray<UnionPlan>,
	// Only where a string literal may hold a NUL (the MySQL and MariaDB targets).
	"unions match the model (m": [
		// mariadb-order-by-trailing-nul: `''` and `'\0'` tie in MariaDB's ORDER BY; MySQL orders them.
		{
			orgId: "org_1",
			branches: [
				rows({ k: "rows", select: [["id", { k: "col", col: "Id" }], ["e0", { k: "str", v: "" }]], distinct: false, orderBy: [] }),
				rows({ k: "rows", select: [["id", { k: "col", col: "Id" }], ["e0", { k: "str", v: "\0" }]], distinct: false, orderBy: [] }),
			],
			orderBy: [["id", "asc"], ["e0", "asc"]],
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

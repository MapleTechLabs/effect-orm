// The core builder suite: one list of cases, run against every dialect.
//
// Each case builds its query from a `CoreContext`, which hides the only things
// that differ per dialect (column types, the aggregate catalog, `compile`). The
// rows come from the same fixture on every database, so an expected row that
// holds on ClickHouse must hold on Postgres too, or the case says why not
// (`expected` per target, or `rejects` for a clause a dialect refuses).
import { DateTime } from "effect"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import * as PG from "@maple-dev/effect-orm/postgres"

export type DialectName = "clickhouse" | "postgres"
/** ClickHouse runs twice: `join_use_nulls=0` fills a missing join row with defaults. */
export type Target = "clickhouse" | "clickhouse-join-nulls" | "postgres"

type Col<A> = CH.CHType<string, A, any>
type Orders = {
	readonly OrgId: Col<string>
	readonly Id: Col<number>
	readonly Customer: Col<string>
	readonly Amount: Col<number>
	readonly Status: Col<string>
	readonly Note: Col<string | null>
	readonly Created: Col<DateTime.Utc>
}
type Customers = { readonly OrgId: Col<string>; readonly Name: Col<string>; readonly Tier: Col<string> }

export interface CoreContext {
	readonly dialect: DialectName
	readonly orders: CH.Table<"orders", Orders>
	readonly customers: CH.Table<"customers", Customers>
	/** `from(table)` with the fixture CTEs attached, so every database reads the same rows. */
	readonly from: <Name extends string, Cols extends CH.ColumnDefs>(
		table: CH.Table<Name, Cols>,
	) => CH.CHQuery<Cols, {}, {}>
	readonly types: { readonly text: Col<string>; readonly int: Col<number> }
	readonly fn: {
		readonly count: () => CH.Expr<number>
		readonly countIf: (condition: CH.Condition) => CH.Expr<number>
		readonly sum: (expr: CH.Expr<number>) => CH.Expr<number | null>
		readonly min: (expr: CH.Expr<number>) => CH.Expr<number | null>
		readonly max: (expr: CH.Expr<number>) => CH.Expr<number | null>
		readonly coalesce: (expr: CH.Expr<string | null>, fallback: CH.Expr<string>) => CH.Expr<string>
	}
	readonly compile: (query: CH.CHQuery<any, any, any>, params?: Record<string, unknown>) => CH.CompiledQuery<any>
	readonly compileUnion: (union: CH.CHUnionQuery<any>, params?: Record<string, unknown>) => CH.CompiledQuery<any>
}

export interface CoreCase {
	readonly id: string
	readonly covers: readonly string[]
	readonly build: (ctx: CoreContext) => CH.CompiledQuery<any>
	/** Rows every target returns, unless `expectedBy` names the target. */
	readonly expected?: readonly unknown[]
	readonly expectedBy?: Partial<Record<Target, readonly unknown[]>>
	/** ClickHouse output format, for the `format` cases. */
	readonly format?: "JSON" | "JSONEachRow"
	readonly metadata?: { readonly route: string; readonly tenantScope: CH.TenantScope }
	/** Dialects that must refuse to compile this case, and the error they give. */
	readonly rejects?: Partial<Record<DialectName, RegExp>>
}

export const expectedFor = (fixture: CoreCase, target: Target): readonly unknown[] | undefined =>
	fixture.expectedBy?.[target] ?? fixture.expected

// Fixture

interface FixtureColumn {
	readonly name: string
	readonly clickhouse: string
	readonly postgres: string
}
const fixtureColumns = {
	orders: [
		{ name: "OrgId", clickhouse: "String", postgres: "text" },
		{ name: "Id", clickhouse: "UInt32", postgres: "int4" },
		{ name: "Customer", clickhouse: "String", postgres: "text" },
		{ name: "Amount", clickhouse: "Int64", postgres: "int8" },
		{ name: "Status", clickhouse: "String", postgres: "text" },
		{ name: "Note", clickhouse: "Nullable(String)", postgres: "text" },
		{ name: "Created", clickhouse: "DateTime64(3, 'UTC')", postgres: "timestamptz" },
	],
	customers: [
		{ name: "OrgId", clickhouse: "String", postgres: "text" },
		{ name: "Name", clickhouse: "String", postgres: "text" },
		{ name: "Tier", clickhouse: "String", postgres: "text" },
	],
} satisfies Record<string, readonly FixtureColumn[]>

type Value = string | number | null
const fixtureRows: Record<keyof typeof fixtureColumns, ReadonlyArray<ReadonlyArray<Value>>> = {
	orders: [
		["org_1", 1, "acme", 10, "paid", "rush", "2026-01-01 00:00:00.000"],
		["org_1", 2, "acme", 20, "paid", null, "2026-01-01 00:10:00.000"],
		["org_1", 3, "globex", 5, "open", null, "2026-01-01 00:20:00.000"],
		["org_1", 4, "initech", 7, "void", "it's", "2026-01-01 00:30:00.000"],
		["org_2", 5, "acme", 99, "paid", null, "2026-01-01 00:40:00.000"],
	],
	customers: [
		["org_1", "acme", "gold"],
		["org_1", "globex", "silver"],
		["org_1", "umbrella", "bronze"],
		["org_2", "acme", "platinum"],
	],
}

// Fixture values have no backslashes, so doubling quotes is a complete escape on both databases.
const sqlValue = (value: Value): string =>
	value === null ? "NULL" : typeof value === "number" ? String(value) : `'${value.replaceAll("'", "''")}'`

/** The fixture table as a CTE body: no DDL, so the ClickHouse suite stays read-only. */
export const fixtureSql = (dialect: DialectName, table: keyof typeof fixtureColumns): string => {
	const columns: readonly FixtureColumn[] = fixtureColumns[table]
	const tuples = fixtureRows[table].map((row) => `(${row.map(sqlValue).join(", ")})`).join(", ")
	if (dialect === "clickhouse") {
		const structure = columns.map((column) => `${column.name} ${column.clickhouse}`).join(", ")
		return `SELECT * FROM values('${structure.replaceAll("'", "\\'")}', ${tuples})`
	}
	const casts = columns.map((column, i) => `CAST("c${i}" AS ${column.postgres}) AS "${column.name}"`).join(", ")
	const names = columns.map((_, i) => `"c${i}"`).join(", ")
	return `SELECT ${casts} FROM (VALUES ${tuples}) AS v(${names})`
}

const withFixtures = (dialect: DialectName) =>
	<Name extends string, Cols extends CH.ColumnDefs>(table: CH.Table<Name, Cols>) =>
		CH.from(table)
			.withCTE("orders", fixtureSql(dialect, "orders"))
			.withCTE("customers", fixtureSql(dialect, "customers")) as CH.CHQuery<Cols, {}, {}>

// Contexts

export const clickhouseContext: CoreContext = {
	dialect: "clickhouse",
	orders: CH.table("orders", {
		external: true,
		tenantColumn: "OrgId",
		columns: {
			OrgId: CH.string,
			Id: CH.uint32,
			Customer: CH.string,
			Amount: CH.int64,
			Status: CH.string,
			Note: CH.nullable(CH.string),
			Created: CH.dateTime64,
		},
	}),
	customers: CH.table("customers", { external: true, columns: { OrgId: CH.string, Name: CH.string, Tier: CH.string }, tenantColumn: "OrgId" }),
	from: withFixtures("clickhouse"),
	types: { text: CH.string, int: CH.int64 },
	fn: {
		count: () => CH.count(),
		countIf: (condition) => CH.countIf(condition),
		sum: (expr) => CH.sum(expr),
		min: (expr) => CH.min(expr),
		max: (expr) => CH.max(expr),
		coalesce: (expr, fallback) => CH.coalesce(expr, fallback),
	},
	compile: (query, params = {}) => CH.compileUnsafe(query, params),
	compileUnion: (union, params = {}) => CH.compileUnionUnsafe(union, params),
}

export const postgresContext: CoreContext = {
	dialect: "postgres",
	orders: PG.table("orders", {
		external: true,
		tenantColumn: "OrgId",
		columns: {
			OrgId: PG.text,
			Id: PG.int4,
			Customer: PG.text,
			Amount: PG.int8,
			Status: PG.text,
			Note: PG.nullable(PG.text),
			Created: PG.timestamptz,
		},
	}),
	customers: PG.table("customers", { external: true, columns: { OrgId: PG.text, Name: PG.text, Tier: PG.text }, tenantColumn: "OrgId" }),
	from: withFixtures("postgres"),
	types: { text: PG.text, int: PG.int8 },
	fn: {
		count: () => PG.count(),
		countIf: (condition) => PG.countIf(condition),
		sum: (expr) => PG.sum(expr),
		min: (expr) => PG.min(expr),
		max: (expr) => PG.max(expr),
		coalesce: (expr, fallback) => PG.coalesce(expr, fallback),
	},
	compile: (query, params = {}) => PG.compileUnsafe(query, params),
	compileUnion: (union, params = {}) => PG.compileUnionUnsafe(union, params),
}

export const contexts: Record<DialectName, CoreContext> = {
	clickhouse: clickhouseContext,
	postgres: postgresContext,
}

// Cases

const org = { orgId: "org_1" }
const q = (...names: string[]) => names.map((name) => `query:${name}`)
const u = (...names: string[]) => names.map((name) => `union:${name}`)
const e = (...names: string[]) => names.map((name) => `expr:${name}`)
const c = (...names: string[]) => names.map((name) => `condition:${name}`)
const p = (...names: string[]) => names.map((name) => `param:${name}`)

/** The org's orders, a starting point most cases narrow further. */
const orgOrders = (ctx: CoreContext) =>
	ctx.from(ctx.orders).where(($) => [$.OrgId.eq(CH.param.string("orgId"))])

export const coreCases: readonly CoreCase[] = [
	{
		id: "select-columns",
		covers: [...q("select", "where", "orderBy"), ...e("eq"), ...p("string"), "function:from"],
		build: (ctx) =>
			ctx.compile(
				ctx
					.from(ctx.orders)
					.select("Id", "Customer")
					.where(($) => [$.OrgId.eq(CH.param.string("orgId")), $.Status.eq("paid")])
					.orderBy(["Id", "asc"]),
				org,
			),
		expected: [
			{ Id: 1, Customer: "acme" },
			{ Id: 2, Customer: "acme" },
		],
	},
	{
		id: "comparisons",
		covers: e("neq", "gt", "gte", "lt", "lte"),
		build: (ctx) =>
			ctx.compile(
				ctx
					.from(ctx.orders)
					.select(($) => ({ id: $.Id }))
					.where(($) => [
						$.OrgId.eq(CH.param.string("orgId")),
						$.Status.neq("void"),
						$.Amount.gt(5),
						$.Amount.gte(10),
						$.Amount.lt(20),
						$.Amount.lte(10),
					]),
				org,
			),
		expected: [{ id: 1 }],
	},
	{
		id: "patterns-and-lists",
		covers: [...e("like", "notLike", "ilike", "in_", "notIn"), ...c("and", "or"), "function:not"],
		build: (ctx) =>
			ctx.compile(
				ctx
					.from(ctx.orders)
					.select(($) => ({ id: $.Id }))
					.where(($) => [
						$.OrgId.eq(CH.param.string("orgId")),
						$.Customer.like("%e%").and($.Customer.notLike("i%")),
						$.Status.ilike("PA%").or($.Status.in_("open")),
						$.Id.notIn(3),
						CH.not($.Id.eq(2)),
					])
					.orderBy(["id", "asc"]),
				org,
			),
		// acme (1, 2) and globex (3) match the patterns; 3 and 2 are excluded by notIn and not.
		expected: [{ id: 1 }],
	},
	{
		id: "arithmetic",
		covers: e("add", "sub", "mul", "mod", "div"),
		build: (ctx) =>
			ctx.compile(
				ctx
					.from(ctx.orders)
					.select(($) => ({
						added: $.Amount.add(1),
						subtracted: $.Amount.sub(1),
						multiplied: $.Amount.mul(2),
						remainder: $.Amount.mod(3),
						divided: $.Amount.div(2),
					}))
					.where(($) => [$.OrgId.eq(CH.param.string("orgId")), $.Id.eq(4)]),
				org,
			),
		// `/` is float division on ClickHouse and integer division on two Postgres integers.
		expectedBy: {
			clickhouse: [{ added: 8, subtracted: 6, multiplied: 14, remainder: 1, divided: 3.5 }],
			"clickhouse-join-nulls": [{ added: 8, subtracted: 6, multiplied: 14, remainder: 1, divided: 3.5 }],
			postgres: [{ added: 8, subtracted: 6, multiplied: 14, remainder: 1, divided: 3 }],
		},
	},
	{
		id: "nulls-and-literals",
		covers: ["function:lit"],
		build: (ctx) =>
			ctx.compile(
				ctx
					.from(ctx.orders)
					.select(($) => ({ id: $.Id, note: $.Note, shown: ctx.fn.coalesce($.Note, CH.lit("-")), label: CH.lit("x'y") }))
					.where(($) => [$.OrgId.eq(CH.param.string("orgId")), $.Id.in_(2, 4)])
					.orderBy(["id", "asc"]),
				org,
			),
		expected: [
			{ id: 2, note: null, shown: "-", label: "x'y" },
			{ id: 4, note: "it's", shown: "it's", label: "x'y" },
		],
	},
	{
		id: "group-having",
		covers: q("groupBy", "having"),
		build: (ctx) =>
			ctx.compile(
				ctx
					.from(ctx.orders)
					.select(($) => ({
						customer: $.Customer,
						orders: ctx.fn.count(),
						paid: ctx.fn.countIf($.Status.eq("paid")),
						total: ctx.fn.sum($.Amount),
						smallest: ctx.fn.min($.Amount),
						largest: ctx.fn.max($.Amount),
					}))
					.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])
					.groupBy("customer")
					.having(() => [ctx.fn.count().gte(2)])
					.orderBy(["customer", "asc"]),
				org,
			),
		expected: [{ customer: "acme", orders: 2, paid: 2, total: 30, smallest: 10, largest: 20 }],
	},
	{
		id: "limit-offset",
		covers: q("limit", "offset"),
		build: (ctx) =>
			ctx.compile(
				ctx
					.from(ctx.orders)
					.select(($) => ({ id: $.Id }))
					.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])
					.orderBy(["id", "desc"])
					.limit(2)
					.offset(1),
				org,
			),
		expected: [{ id: 3 }, { id: 2 }],
	},
	{
		id: "params",
		covers: p("int", "float", "dateTime", "of"),
		build: (ctx) =>
			ctx.compile(
				ctx
					.from(ctx.orders)
					.select(($) => ({ id: $.Id, created: $.Created }))
					.where(($) => [
						$.OrgId.eq(CH.param.of(ctx.types.text, "orgId")),
						$.Amount.gte(CH.param.int("min")),
						$.Amount.lt(CH.param.float("max")),
						$.Created.gte(CH.param.dateTime("start")),
					])
					.orderBy(["id", "asc"]),
				{ ...org, min: 7, max: 19.5, start: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z") },
			),
		expected: [
			{ id: 1, created: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z") },
			{ id: 4, created: DateTime.makeUnsafe("2026-01-01T00:30:00.000Z") },
		],
	},
	{
		id: "selected-param",
		covers: p("bool"),
		build: (ctx) =>
			ctx.compile(
				orgOrders(ctx)
					.select(($) => ({ id: $.Id, flagged: CH.param.bool("flag") }))
					.where(($) => [$.Id.eq(1)]),
				{ ...org, flag: true },
			),
		expected: [{ id: 1, flagged: true }],
	},
	{
		id: "inner-join",
		covers: q("innerJoin"),
		build: (ctx) =>
			ctx.compile(
				orgOrders(ctx)
					.innerJoin(ctx.customers, "c", (o, c) => o.Customer.eq(c.Name).and(o.OrgId.eq(c.OrgId)))
					.select(($) => ({ id: $.Id, tier: $.c.Tier }))
					.orderBy(["id", "asc"]),
				org,
			),
		expected: [
			{ id: 1, tier: "gold" },
			{ id: 2, tier: "gold" },
			{ id: 3, tier: "silver" },
		],
	},
	{
		id: "left-join",
		covers: q("leftJoin"),
		build: (ctx) =>
			ctx.compile(
				orgOrders(ctx)
					.leftJoin(ctx.customers, "c", (o, c) => o.Customer.eq(c.Name).and(o.OrgId.eq(c.OrgId)))
					.select(($) => ({ id: $.Id, tier: $.c.Tier }))
					.where(($) => [$.Id.gte(3)])
					.orderBy(["id", "asc"]),
				org,
			),
		// initech has no customer row: NULL, or the column default without join_use_nulls.
		expected: [
			{ id: 3, tier: "silver" },
			{ id: 4, tier: null },
		],
		expectedBy: {
			clickhouse: [
				{ id: 3, tier: "silver" },
				{ id: 4, tier: "" },
			],
		},
	},
	{
		id: "cross-join",
		covers: q("crossJoin"),
		build: (ctx) =>
			ctx.compile(
				ctx
					.from(ctx.orders)
					.crossJoin(ctx.customers, "c")
					.select(($) => ({ id: $.Id, customer: $.c.Name }))
					.where(($) => [$.OrgId.eq(CH.param.string("orgId")), $.c.OrgId.eq("org_1"), $.Id.lte(2)])
					.orderBy(["id", "asc"], ["customer", "asc"]),
				org,
			),
		expected: [
			{ id: 1, customer: "acme" },
			{ id: 1, customer: "globex" },
			{ id: 1, customer: "umbrella" },
			{ id: 2, customer: "acme" },
			{ id: 2, customer: "globex" },
			{ id: 2, customer: "umbrella" },
		],
	},
	{
		id: "join-subqueries",
		covers: q("innerJoinQuery", "leftJoinQuery"),
		build: (ctx) => {
			const tiers = ctx
				.from(ctx.customers)
				.select(($) => ({ name: $.Name, tier: $.Tier }))
				.where(($) => [$.OrgId.eq(CH.param.string("orgId")), $.Tier.neq("silver")])
			const counts = ctx
				.from(ctx.orders)
				.select(($) => ({ customer: $.Customer, orders: ctx.fn.count() }))
				.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])
				.groupBy("customer")
			return ctx.compile(
				ctx
					.from(ctx.customers)
					.innerJoinQuery(tiers, "t", (c, t) => c.Name.eq(t.name))
					.leftJoinQuery(counts, "n", (c, n) => c.Name.eq(n.customer))
					.select(($) => ({ name: $.Name, tier: $.t.tier, orders: $.n.orders }))
					.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])
					.orderBy(["name", "asc"]),
				org,
			)
		},
		// umbrella has no orders: NULL, or 0 without join_use_nulls.
		expected: [
			{ name: "acme", tier: "gold", orders: 2 },
			{ name: "umbrella", tier: "bronze", orders: null },
		],
		expectedBy: {
			clickhouse: [
				{ name: "acme", tier: "gold", orders: 2 },
				{ name: "umbrella", tier: "bronze", orders: 0 },
			],
		},
	},
	{
		id: "cross-join-subquery",
		covers: q("crossJoinQuery"),
		build: (ctx) => {
			const customers = ctx
				.from(ctx.customers)
				.select(() => ({ customers: ctx.fn.count() }))
				.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])
			return ctx.compile(
				orgOrders(ctx)
					.crossJoinQuery(customers, "k")
					.select(($) => ({ id: $.Id, customers: $.k.customers }))
					.where(($) => [$.Id.lte(2)])
					.orderBy(["id", "asc"]),
				org,
			)
		},
		expected: [
			{ id: 1, customers: 3 },
			{ id: 2, customers: 3 },
		],
	},
	{
		id: "from-subquery",
		covers: ["function:fromQuery"],
		build: (ctx) => {
			const totals = ctx
				.from(ctx.orders)
				.select(($) => ({ OrgId: $.OrgId, customer: $.Customer, total: ctx.fn.sum($.Amount) }))
				.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])
				.groupBy("OrgId", "customer")
			return ctx.compile(
				CH.fromQuery(totals, "t")
					.select(($) => ({ customer: $.customer, total: $.total }))
					.where(($) => [$.total.gt(6)])
					.orderBy(["total", "desc"]),
				org,
			)
		},
		expected: [
			{ customer: "acme", total: 30 },
			{ customer: "initech", total: 7 },
		],
	},
	{
		id: "cte",
		covers: q("withCTE"),
		build: (ctx) => {
			const paid = CH.table("paid", { external: true, columns: { Customer: ctx.types.text, Amount: ctx.types.int } })
			return ctx.compile(
				ctx
					.from(paid)
					.withCTE(
						"paid",
						ctx
							.from(ctx.orders)
							.select(($) => ({ Customer: $.Customer, Amount: $.Amount }))
							.where(($) => [$.OrgId.eq(CH.param.string("orgId")), $.Status.eq("paid")]),
					)
					.select(($) => ({ total: ctx.fn.sum($.Amount) })),
				org,
			)
		},
		expected: [{ total: 30 }],
	},
	{
		id: "union",
		covers: [...u("orderBy", "limit", "offset"), "function:unionAll"],
		build: (ctx) => {
			const status = (name: string) =>
				ctx
					.from(ctx.orders)
					.select(($) => ({ status: $.Status, total: ctx.fn.sum($.Amount) }))
					.where(($) => [$.OrgId.eq(CH.param.string("orgId")), $.Status.eq(CH.param.string(name))])
					.groupBy("status")
			return ctx.compileUnion(
				CH.unionAll(status("first"), status("second"), status("third"))
					.orderBy(["total", "desc"])
					.limit(2)
					.offset(1),
				{ ...org, first: "paid", second: "open", third: "void" },
			)
		},
		expected: [
			{ status: "void", total: 7 },
			{ status: "open", total: 5 },
		],
	},
	{
		id: "route-and-cross-tenant",
		covers: q("route", "crossTenant"),
		metadata: { route: "reports", tenantScope: "cross-tenant" },
		build: (ctx) =>
			ctx.compile(
				ctx
					.from(ctx.orders)
					.select(() => ({ orders: ctx.fn.count() }))
					.route("reports")
					.crossTenant(),
			),
		expected: [{ orders: 5 }],
	},
	{
		id: "format",
		covers: q("format"),
		format: "JSON",
		rejects: { postgres: /no FORMAT clause/ },
		build: (ctx) =>
			ctx.compile(
				orgOrders(ctx)
					.select(($) => ({ id: $.Id }))
					.where(($) => [$.Id.eq(1)])
					.format("JSON"),
				org,
			),
		expected: [{ id: 1 }],
	},
	{
		id: "union-format",
		covers: u("format"),
		format: "JSON",
		rejects: { postgres: /no FORMAT clause/ },
		build: (ctx) => {
			const one = (id: number) =>
				orgOrders(ctx)
					.select(($) => ({ id: $.Id }))
					.where(($) => [$.Id.eq(id)])
			return ctx.compileUnion(CH.unionAll(one(1), one(2)).orderBy(["id", "asc"]).format("JSON"), org)
		},
		expected: [{ id: 1 }, { id: 2 }],
	},
	// Null and range predicates, variadic and/or, distinct, row locking.
	{
		id: "null-and-range",
		covers: e("isNull", "between", "notBetween"),
		build: (ctx) =>
			ctx.compile(
				orgOrders(ctx)
					.select(($) => ({ id: $.Id }))
					.where(($) => [
						$.Note.isNull(),
						$.Amount.between(5, CH.param.int("hi")),
						$.Id.notBetween(3, 3),
					])
					.orderBy(["id", "asc"]),
				{ ...org, hi: 20 },
			),
		expected: [{ id: 2 }],
	},
	{
		id: "is-not-null",
		covers: e("isNotNull"),
		build: (ctx) =>
			ctx.compile(orgOrders(ctx).select(($) => ({ id: $.Id })).where(($) => [$.Note.isNotNull()]).orderBy(["id", "asc"]), org),
		expected: [{ id: 1 }, { id: 4 }],
	},
	{
		id: "and-or",
		covers: ["function:and", "function:or"],
		build: (ctx) =>
			ctx.compile(
				orgOrders(ctx)
					.select(($) => ({ id: $.Id }))
					.where(($) => [
						CH.or(CH.and($.Status.eq("paid"), $.Amount.gt(15)), undefined, $.Customer.eq("globex")),
					])
					.orderBy(["id", "asc"]),
				org,
			),
		expected: [{ id: 2 }, { id: 3 }],
	},
	{
		id: "distinct",
		covers: q("distinct", "distinctOn"),
		build: (ctx) =>
			ctx.compile(
				orgOrders(ctx)
					.select(($) => ({ customer: $.Customer, id: $.Id }))
					.distinctOn("customer")
					.orderBy(["customer", "asc"], ["id", "desc"]),
				org,
			),
		expected: [
			{ customer: "acme", id: 2 },
			{ customer: "globex", id: 3 },
			{ customer: "initech", id: 4 },
		],
	},
	{
		id: "distinct-plain",
		covers: q("distinct"),
		build: (ctx) =>
			ctx.compile(orgOrders(ctx).select(($) => ({ status: $.Status })).distinct().orderBy(["status", "asc"]), org),
		expected: [{ status: "open" }, { status: "paid" }, { status: "void" }],
	},
	{
		id: "locking",
		covers: q("forUpdate", "forNoKeyUpdate", "forShare", "forKeyShare"),
		rejects: { clickhouse: /no row locks/ },
		build: (ctx) => {
			// Each strength compiles; the one sent is FOR UPDATE SKIP LOCKED.
			const base = orgOrders(ctx).select(($) => ({ id: $.Id })).where(($) => [$.Id.eq(1)])
			for (const locked of [base.forNoKeyUpdate({ noWait: true }), base.forShare(), base.forKeyShare()]) ctx.compile(locked, org)
			return ctx.compile(base.forUpdate({ skipLocked: true }), org)
		},
		expected: [{ id: 1 }],
	},
]

/** Cases a dialect cannot run yet, each with the reason. Empty is the goal. */
export const coreSkips: Record<DialectName, Record<string, string>> = {
	clickhouse: {},
	postgres: {},
}

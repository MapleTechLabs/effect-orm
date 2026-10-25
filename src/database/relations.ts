// Relational reads: relations declared over tables, and `findMany` with a
// nested `with`, as Drizzle's relational queries and Prisma's `include`.
//
// Each level of `with` is one ordinary builder query, `WHERE <key> IN (...)`
// over the keys the level above returned. So every level compiles, decodes and
// derives its tenant scope the way any other query does, and `run` checks it.
// See design/relations.md for why this and not JSON aggregation.

import { Effect } from "effect"
import type { CompiledQueryDecodeError } from "../ch/compile"
import type { QueryBuilderError } from "../ch/errors"
import { and, lit, makeCond, makeExpr, not, type Condition, type Expr, type ParamsIn } from "../ch/expr"
import { builtins } from "../ch/functions/builtin"
import { from, type ColumnAccessor, type CHQuery } from "../ch/query"
import { exists, subqueryExpr } from "../ch/subquery"
import type { SelectRowOf, Table } from "../ch/table"
import { markCorrelatedTenant, tenantColumnOf } from "../ch/tenant"
import { custom, type ColumnDefs, type InferTS } from "../ch/types"
import { PgNumber } from "../pg/types"
import { raw } from "../sql/sql-fragment"
import { Database } from "./database"
import type { DatabaseError } from "./errors"

type AnyTable = Table<string, any, any, any>

/** The tables a relation schema covers, by the key relations use to name them. */
export type RelationTables = Record<string, AnyTable>

type ColumnsOf<T> = T extends Table<any, infer Cols, any, any> ? Cols : never

/**
 * Columns a relation can join on: their decoded value is a string, number or
 * bigint, which the loader matches by value. A `DateTime` or bytes column is
 * not a key.
 */
export type KeyColumn<T> = {
	[K in keyof ColumnsOf<T>]: NonNullable<InferTS<ColumnsOf<T>[K]>> extends string | number | bigint ? K : never
}[keyof ColumnsOf<T>] &
	string

/**
 * A relation from one table to another: rows of `target` whose `to` column
 * equals this row's `from` column. `"one"` loads the first such row or `null`,
 * `"many"` loads all of them.
 */
export interface Relation<
	Kind extends "one" | "many" = "one" | "many",
	Target extends string = string,
	From extends string = string,
	To extends string = string,
> {
	readonly _tag: "Relation"
	readonly kind: Kind
	readonly target: Target
	readonly from: From
	readonly to: To
}

/** What the `defineRelations` callback gets: `r.one` and `r.many`, checked against the tables. */
export interface RelationBuilder<Tables extends RelationTables> {
	readonly one: <const Target extends keyof Tables & string, const From extends string, const To extends KeyColumn<Tables[Target]>>(
		target: Target,
		on: { readonly from: From; readonly to: To },
	) => Relation<"one", Target, From, To>
	readonly many: <const Target extends keyof Tables & string, const From extends string, const To extends KeyColumn<Tables[Target]>>(
		target: Target,
		on: { readonly from: From; readonly to: To },
	) => Relation<"many", Target, From, To>
}

/**
 * The relations of each table, by relation name. `from` must be a key column
 * of the source table, and a relation name must not be one of its columns: the
 * loaded rows carry both.
 */
export type RelationsConfig<Tables extends RelationTables> = {
	readonly [S in keyof Tables]?: { readonly [name: string]: Relation<"one" | "many", keyof Tables & string, KeyColumn<Tables[S]>> } & {
		readonly [C in keyof ColumnsOf<Tables[S]>]?: never
	}
}

type RelationsOf<R, K> = K extends keyof R ? NonNullable<R[K]> : {}

/** One table of a relation schema, as `findMany` takes it: `schema.users`. */
export interface RelationalTable<Tables extends RelationTables, R, K extends keyof Tables & string> {
	readonly _tag: "RelationalTable"
	readonly key: K
	readonly table: Tables[K]
	/** @internal */
	readonly tables: Tables
	/** @internal */
	readonly relations: R
}

/** What `defineRelations` returns: one `RelationalTable` per table key. */
export type RelationalSchema<Tables extends RelationTables, R> = {
	readonly [K in keyof Tables & string]: RelationalTable<Tables, R, K>
}

/**
 * Relations over a set of tables, Drizzle's `defineRelations`. Relations name
 * their target by its key in `tables`, so two tables can point at each other
 * and a table at itself.
 *
 * ```ts
 * const schema = Db.defineRelations({ users: Users, posts: Posts }, (r) => ({
 *   users: { posts: r.many("posts", { from: "id", to: "authorId" }) },
 *   posts: { author: r.one("users", { from: "authorId", to: "id" }) },
 * }))
 * ```
 */
export const defineRelations = <const Tables extends RelationTables, const R extends RelationsConfig<Tables>>(
	tables: Tables,
	build: (r: RelationBuilder<Tables>) => R,
): RelationalSchema<Tables, R> => {
	const relation =
		(kind: "one" | "many") =>
		(target: string, on: { readonly from: string; readonly to: string }): Relation => ({
			_tag: "Relation",
			kind,
			target,
			from: on.from,
			to: on.to,
		})
	const relations = build({ one: relation("one"), many: relation("many") } as unknown as RelationBuilder<Tables>)
	return Object.fromEntries(
		Object.keys(tables).map((key) => [key, { _tag: "RelationalTable", key, table: tables[key], tables, relations }]),
	) as unknown as RelationalSchema<Tables, R>
}

// Relation filters and counts
//
// `some`, `none` and `every` are correlated `EXISTS` / `NOT EXISTS` conditions,
// and `count` is a correlated `count(*)` subquery. The subquery reads the target
// table under its own alias, matches `<to> = <outer from>`, and, when both
// tables declare a tenant column, `<tenant> = <outer tenant>`. That last
// equality is what keeps the subquery inside the outer query's tenant: the
// compiler gives the subquery the outer column's binding (see `tenant.ts`).

type TargetOf<R, K, N> = N extends keyof RelationsOf<R, K>
	? RelationsOf<R, K>[N] extends Relation<any, infer T extends string>
		? T
		: never
	: never

/** The conditions a relation filter adds to its subquery. */
export type RelationWhere<Tables extends RelationTables, R, K extends keyof Tables & string> = (
	$: ColumnAccessor<ColumnsOf<Tables[K]>>,
	r: Related<Tables, R, K>,
) => ReadonlyArray<Condition | undefined>

type Conditions = ReadonlyArray<Condition | undefined>

/** The filters and the count of one relation, built on the outer query's `$`. */
export interface RelationFilter<Tables extends RelationTables, R, K extends keyof Tables & string> {
	/** At least one related row matches: `EXISTS (…)`. With no `where`, any related row. */
	readonly some: <const C extends Conditions = []>(
		where?: ($: ColumnAccessor<ColumnsOf<Tables[K]>>, r: Related<Tables, R, K>) => C,
	) => Condition<ParamsIn<C[number]>>
	/** No related row matches: `NOT EXISTS (…)`. With no `where`, no related row at all. */
	readonly none: <const C extends Conditions = []>(
		where?: ($: ColumnAccessor<ColumnsOf<Tables[K]>>, r: Related<Tables, R, K>) => C,
	) => Condition<ParamsIn<C[number]>>
	/** Every related row matches: `NOT EXISTS (… AND NOT (where))`. True when there is none. */
	readonly every: <const C extends Conditions>(
		where: ($: ColumnAccessor<ColumnsOf<Tables[K]>>, r: Related<Tables, R, K>) => C,
	) => Condition<ParamsIn<C[number]>>
	/** The number of related rows that match, as a correlated `count(*)` subquery. */
	readonly count: <const C extends Conditions = []>(
		where?: ($: ColumnAccessor<ColumnsOf<Tables[K]>>, r: Related<Tables, R, K>) => C,
	) => Expr<number, ParamsIn<C[number]>>
}

/** What `related` returns: one `RelationFilter` per relation of the table. */
export type Related<Tables extends RelationTables, R, K extends keyof Tables & string> = {
	readonly [N in keyof RelationsOf<R, K> & string]: RelationFilter<Tables, R, TargetOf<R, K, N> & keyof Tables & string>
}

const aggregate = builtins("portable", "aggregate")
/** `count(*)` is the same in every dialect; a driver sends it as a number, a string or a bigint. */
const countType = custom("Int64", PgNumber)
const countAll = (): Expr<number> => makeExpr(aggregate.lazy(() => "count(*)", "count"), countType.schema)
const always = (): Condition => makeCond(raw("1 = 1"))

const relatedOf = (
	tables: RelationTables,
	relations: Record<string, Record<string, Relation> | undefined>,
	key: string,
	$: any,
): Record<string, RelationFilter<any, any, any>> =>
	Object.fromEntries(
		Object.entries(relations[key] ?? {}).map(([name, relation]) => {
			const parent = tables[key]!
			const target = tables[relation.target]!
			const outerFrom = $[relation.from]
			// `$` is qualified (`alias.column`): the subquery's alias extends it, so
			// it never hides the outer source, even for a table related to itself.
			const outerName: string = outerFrom.columnName
			const alias = `${outerName.slice(0, outerName.length - relation.from.length - 1)}__${name}`
			const outerTenant =
				parent.tenantColumn !== undefined && target.tenantColumn !== undefined ? $[parent.tenantColumn] : undefined
			const outerTenantColumn = outerTenant === undefined ? undefined : tenantColumnOf(outerTenant)
			const inner = (
				where: (($: any, r: any) => ReadonlyArray<Condition | undefined>) | undefined,
				select: () => Record<string, Expr<any>>,
				negate = false,
			): CHQuery<any, any, any, any> => {
				const query = from(target as Table<string, ColumnDefs>, alias)
					.select(select as any)
					.where((c: any) => {
						const conditions = where?.(c, relatedOf(tables, relations, relation.target, c)) ?? []
						const own = negate ? [not(and(...conditions) ?? always())] : conditions
						return [
							c[relation.to].eq(outerFrom),
							outerTenant === undefined ? undefined : c[target.tenantColumn!].eq(outerTenant),
							...own,
						]
					})
				return outerTenantColumn === undefined ? query : markCorrelatedTenant(query, outerTenantColumn)
			}
			const one = () => ({ one: lit(1) })
			const filter: RelationFilter<any, any, any> = {
				some: (where?: any) => exists(inner(where, one) as any),
				none: (where?: any) => not(exists(inner(where, one) as any)),
				every: (where: any) => not(exists(inner(where, one, true) as any)),
				count: (where?: any) =>
					subqueryExpr(inner(where, () => ({ n: countAll() })) as any, countType, (sql) => `coalesce((${sql}), 0)`) as any,
			}
			return [name, filter]
		}),
	)

/**
 * The relation filters and counts of a table, on the `$` of a builder query
 * over that table:
 *
 * ```ts
 * PG.from(Users)
 *   .select(($) => ({ id: $.id, posts: Db.related(schema.users, $).posts.count() }))
 *   .where(($) => [Db.related(schema.users, $).posts.some(($) => [$.published.eq(true)])])
 * ```
 *
 * `findMany`'s `where` gets the same object as its second argument.
 */
export const related = <Tables extends RelationTables, R, K extends keyof Tables & string>(
	table: RelationalTable<Tables, R, K>,
	$: ColumnAccessor<ColumnsOf<Tables[K]>>,
): Related<Tables, R, K> => relatedOf(table.tables, table.relations as any, table.key, $) as unknown as Related<Tables, R, K>

/** Options for one nested level of `with`. */
export interface RelationOptions<Tables extends RelationTables, R, K extends keyof Tables & string> {
	/**
	 * More conditions on this level, ANDed with the relation's key match. The
	 * second argument holds the relation filters of this level's table.
	 */
	readonly where?: RelationWhere<Tables, R, K>
	/** The order of this level's rows, within each parent. */
	readonly orderBy?: ($: ColumnAccessor<ColumnsOf<Tables[K]>>) => ReadonlyArray<readonly [Expr<any>, "asc" | "desc"]>
	/** Relations to load under each row of this level. */
	readonly with?: WithOf<Tables, R, K>
	/** Relations to count under each row of this level, Prisma's `_count`. */
	readonly _count?: CountOf<Tables, R, K>
}

/** `with`: each relation to load, as `true` or with its own options. */
export type WithOf<Tables extends RelationTables, R, K extends keyof Tables & string> = {
	readonly [N in keyof RelationsOf<R, K>]?:
		| true
		| (RelationsOf<R, K>[N] extends Relation<any, infer T extends keyof Tables & string> ? RelationOptions<Tables, R, T> : never)
}

/** `_count`: each `many` relation to count, as `true` or with a `where`. A `one` relation is refused. */
export type CountOf<Tables extends RelationTables, R, K extends keyof Tables & string> = {
	readonly [N in keyof RelationsOf<R, K>]?: RelationsOf<R, K>[N] extends Relation<"many", infer T extends keyof Tables & string>
		? true | { readonly where?: RelationWhere<Tables, R, T> }
		: never
}

/** Options for `findMany`: the top level also takes `limit`, `offset` and `crossTenant`. */
export interface FindManyOptions<Tables extends RelationTables, R, K extends keyof Tables & string>
	extends RelationOptions<Tables, R, K> {
	readonly limit?: number
	readonly offset?: number
	/** Declare every level `.crossTenant()`; see docs/tenant-scoping.md. */
	readonly crossTenant?: boolean
}

type WithIn<O> = O extends { readonly with?: infer W } ? (W extends object ? W : {}) : {}
type CountIn<O> = O extends { readonly _count?: infer C } ? (C extends object ? C : {}) : {}

type Simplify<A> = { readonly [K in keyof A]: A[K] } & {}

/**
 * A row `findMany` returns: every column of the table, plus each relation
 * `with` asked for, plus `_count` when the level counts relations.
 */
export type FindManyRow<Tables extends RelationTables, R, K extends keyof Tables & string, W, C = {}> = Simplify<
	SelectRowOf<Tables[K]> & {
		readonly [N in keyof W & keyof RelationsOf<R, K> as W[N] extends undefined ? never : N]: RelationsOf<R, K>[N] extends Relation<
			infer Kind,
			infer T extends keyof Tables & string
		>
			? Kind extends "many"
				? ReadonlyArray<FindManyRow<Tables, R, T, WithIn<W[N]>, CountIn<W[N]>>>
				: FindManyRow<Tables, R, T, WithIn<W[N]>, CountIn<W[N]>> | null
			: never
	} & ([keyof C] extends [never]
			? {}
			: { readonly _count: { readonly [N in keyof C as C[N] extends undefined ? never : N]: number } })
>

type FindError = DatabaseError | QueryBuilderError | CompiledQueryDecodeError
type Row = Record<string, unknown>
type LevelWhere = ($: any, r: any) => ReadonlyArray<Condition | undefined>
interface Level {
	readonly where?: LevelWhere
	readonly orderBy?: ($: any) => ReadonlyArray<readonly [Expr<any>, "asc" | "desc"]>
	readonly with?: Record<string, true | Level | undefined>
	readonly _count?: Record<string, true | { readonly where?: LevelWhere } | undefined>
	readonly limit?: number
	readonly offset?: number
}
type Relations = Record<string, Record<string, Relation> | undefined>

const distinct = (values: ReadonlyArray<unknown>): Array<unknown> => [
	...new Set(values.filter((value) => value !== null && value !== undefined)),
]

const levelQuery = (
	tables: RelationTables,
	relations: Relations,
	key: string,
	level: Level,
	match: ($: any) => ReadonlyArray<Condition | undefined>,
	crossTenant: boolean,
): CHQuery<any, any, any, any> => {
	let query: CHQuery<any, any, any, any> = from(tables[key] as Table<string, ColumnDefs>)
		.select()
		.where(($: any) => [...match($), ...(level.where?.($, relatedOf(tables, relations, key, $)) ?? [])])
	if (level.orderBy !== undefined) query = query.orderBy(level.orderBy as any)
	if (level.limit !== undefined) query = query.limit(level.limit)
	if (level.offset !== undefined) query = query.offset(level.offset)
	return crossTenant ? query.crossTenant() : query
}

/**
 * The key match of a nested level, `<to> IN (<keys>)`. The child level keeps
 * the tenant its parents were read for: when the parent rows all carry one
 * tenant, the child query pins its own tenant column to it, so its scope is
 * proved like any other query's.
 */
const keyMatch = (parent: AnyTable, target: AnyTable, relation: Relation, rows: ReadonlyArray<Row>, keys: ReadonlyArray<unknown>) => {
	const tenants =
		parent.tenantColumn !== undefined && target.tenantColumn !== undefined
			? distinct(rows.map((row) => row[parent.tenantColumn!]))
			: []
	const tenantColumn = target.tenantColumn
	return ($: any): ReadonlyArray<Condition | undefined> => [
		$[relation.to].in_(...keys),
		tenantColumn !== undefined && tenants.length === 1 ? $[tenantColumn].eq(tenants[0]) : undefined,
	]
}

const relationOf = (relations: Relations, key: string, name: string): Effect.Effect<Relation> => {
	const relation = relations[key]?.[name]
	return relation === undefined ? Effect.die(new Error(`findMany: ${key} has no relation named ${name}`)) : Effect.succeed(relation)
}

/**
 * Load the relations `level.with` asks for under `rows` of `table`: one query
 * per relation, then the next level under its rows. Then count the relations
 * `level._count` asks for: one grouped query per relation.
 */
const attach = (
	tables: RelationTables,
	relations: Relations,
	key: string,
	rows: ReadonlyArray<Row>,
	level: Level,
	crossTenant: boolean,
): Effect.Effect<ReadonlyArray<Row>, FindError, Database> =>
	Effect.gen(function* () {
		const names = Object.entries(level.with ?? {}).filter(([, spec]) => spec !== undefined)
		const counted = Object.entries(level._count ?? {}).filter(([, spec]) => spec !== undefined)
		if (names.length === 0 && counted.length === 0) return rows
		const db = yield* Database
		const parent = tables[key]!
		const loaded: Record<string, Map<unknown, Array<Row>>> = {}
		for (const [name, spec] of names) {
			const relation = yield* relationOf(relations, key, name)
			const target = tables[relation.target]!
			const nested: Level = spec === true ? {} : (spec as Level)
			const keys = distinct(rows.map((row) => row[relation.from]))
			let children: ReadonlyArray<Row> = []
			if (keys.length > 0) {
				const query = levelQuery(tables, relations, relation.target, nested, keyMatch(parent, target, relation, rows, keys), crossTenant)
				const decoded = (yield* db.run(query as any)) as ReadonlyArray<Row>
				children = yield* attach(tables, relations, relation.target, decoded, nested, crossTenant)
			}
			const byKey = new Map<unknown, Array<Row>>()
			for (const child of children) {
				const value = child[relation.to]
				const group = byKey.get(value)
				if (group === undefined) byKey.set(value, [child])
				else group.push(child)
			}
			loaded[name] = byKey
		}
		const counts: Record<string, Map<unknown, number>> = {}
		for (const [name, spec] of counted) {
			const relation = yield* relationOf(relations, key, name)
			const target = tables[relation.target]!
			const where = spec === true ? undefined : spec!.where
			const keys = distinct(rows.map((row) => row[relation.from]))
			const byKey = new Map<unknown, number>()
			if (keys.length > 0) {
				// `SELECT <to>, count(*) … WHERE <to> IN (<keys>) GROUP BY <to>`: the
				// same key match and tenant pin as a loaded level.
				const match = keyMatch(parent, target, relation, rows, keys)
				let query: CHQuery<any, any, any, any> = from(target as Table<string, ColumnDefs>)
					.select(($: any) => ({ key: $[relation.to], n: countAll() }))
					.where(($: any) => [...match($), ...(where?.($, relatedOf(tables, relations, relation.target, $)) ?? [])])
					.groupBy("key" as never)
				if (crossTenant) query = query.crossTenant()
				for (const row of (yield* db.run(query as any)) as ReadonlyArray<{ key: unknown; n: number }>) {
					byKey.set(row.key, row.n)
				}
			}
			counts[name] = byKey
		}
		return rows.map((row) => {
			const out: Row = { ...row }
			for (const [name] of names) {
				const relation = relations[key]![name]!
				const group = loaded[name]!.get(row[relation.from]) ?? []
				out[name] = relation.kind === "many" ? group : (group[0] ?? null)
			}
			if (counted.length > 0) {
				out._count = Object.fromEntries(
					counted.map(([name]) => [name, counts[name]!.get(row[relations[key]![name]!.from]) ?? 0]),
				)
			}
			return out
		})
	})

/**
 * Read rows of one table with the relations `with` names, nested to any depth.
 * Each level is one statement, `WHERE <key> IN (...)` over the keys of the
 * level above, decoded through its own row codec. A level whose parents carry
 * one tenant is pinned to it. Levels are separate statements: run `findMany`
 * inside `transaction` for one snapshot across them.
 *
 * `where` gets the level's relation filters as its second argument, and
 * `_count` counts a `many` relation with one grouped statement per level.
 *
 * ```ts
 * Db.findMany(schema.users, {
 *   where: ($, r) => [$.orgId.eq(orgId), r.posts.some()],
 *   with: { posts: { with: { author: true } } },
 *   _count: { posts: true },
 * })
 * ```
 */
export const findMany: {
	<Tables extends RelationTables, R, K extends keyof Tables & string>(
		table: RelationalTable<Tables, R, K>,
	): Effect.Effect<ReadonlyArray<FindManyRow<Tables, R, K, {}>>, FindError, Database>
	<Tables extends RelationTables, R, K extends keyof Tables & string, const O extends FindManyOptions<Tables, R, K>>(
		table: RelationalTable<Tables, R, K>,
		options: O,
	): Effect.Effect<ReadonlyArray<FindManyRow<Tables, R, K, WithIn<O>, CountIn<O>>>, FindError, Database>
} = (table: RelationalTable<RelationTables, unknown, string>, options?: FindManyOptions<RelationTables, unknown, string>) =>
	Effect.gen(function* () {
		const level = (options ?? {}) as Level & { readonly crossTenant?: boolean }
		const crossTenant = level.crossTenant === true
		const relations = table.relations as Relations
		const db = yield* Database
		const rows = (yield* db.run(levelQuery(table.tables, relations, table.key, level, () => [], crossTenant) as any)) as ReadonlyArray<Row>
		return yield* attach(table.tables, relations, table.key, rows, level, crossTenant)
	}) as any

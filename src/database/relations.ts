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
import type { Condition, Expr } from "../ch/expr"
import { from, type ColumnAccessor, type CHQuery } from "../ch/query"
import type { SelectRowOf, Table } from "../ch/table"
import type { ColumnDefs, InferTS } from "../ch/types"
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

/** Options for one nested level of `with`. */
export interface RelationOptions<Tables extends RelationTables, R, K extends keyof Tables & string> {
	/** More conditions on this level, ANDed with the relation's key match. */
	readonly where?: ($: ColumnAccessor<ColumnsOf<Tables[K]>>) => ReadonlyArray<Condition | undefined>
	/** The order of this level's rows, within each parent. */
	readonly orderBy?: ($: ColumnAccessor<ColumnsOf<Tables[K]>>) => ReadonlyArray<readonly [Expr<any>, "asc" | "desc"]>
	/** Relations to load under each row of this level. */
	readonly with?: WithOf<Tables, R, K>
}

/** `with`: each relation to load, as `true` or with its own options. */
export type WithOf<Tables extends RelationTables, R, K extends keyof Tables & string> = {
	readonly [N in keyof RelationsOf<R, K>]?:
		| true
		| (RelationsOf<R, K>[N] extends Relation<any, infer T extends keyof Tables & string> ? RelationOptions<Tables, R, T> : never)
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

type Simplify<A> = { readonly [K in keyof A]: A[K] } & {}

/** A row `findMany` returns: every column of the table, plus each relation `with` asked for. */
export type FindManyRow<Tables extends RelationTables, R, K extends keyof Tables & string, W> = Simplify<
	SelectRowOf<Tables[K]> & {
		readonly [N in keyof W & keyof RelationsOf<R, K> as W[N] extends undefined ? never : N]: RelationsOf<R, K>[N] extends Relation<
			infer Kind,
			infer T extends keyof Tables & string
		>
			? Kind extends "many"
				? ReadonlyArray<FindManyRow<Tables, R, T, WithIn<W[N]>>>
				: FindManyRow<Tables, R, T, WithIn<W[N]>> | null
			: never
	}
>

type FindError = DatabaseError | QueryBuilderError | CompiledQueryDecodeError
type Row = Record<string, unknown>
interface Level {
	readonly where?: ($: any) => ReadonlyArray<Condition | undefined>
	readonly orderBy?: ($: any) => ReadonlyArray<readonly [Expr<any>, "asc" | "desc"]>
	readonly with?: Record<string, true | Level | undefined>
	readonly limit?: number
	readonly offset?: number
}

const distinct = (values: ReadonlyArray<unknown>): Array<unknown> => [
	...new Set(values.filter((value) => value !== null && value !== undefined)),
]

const levelQuery = (
	table: AnyTable,
	level: Level,
	match: ($: any) => ReadonlyArray<Condition | undefined>,
	crossTenant: boolean,
): CHQuery<any, any, any, any> => {
	let query: CHQuery<any, any, any, any> = from(table as Table<string, ColumnDefs>)
		.select()
		.where(($: any) => [...match($), ...(level.where?.($) ?? [])])
	if (level.orderBy !== undefined) query = query.orderBy(level.orderBy as any)
	if (level.limit !== undefined) query = query.limit(level.limit)
	if (level.offset !== undefined) query = query.offset(level.offset)
	return crossTenant ? query.crossTenant() : query
}

/**
 * Load the relations `level.with` asks for under `rows` of `table`: one query
 * per relation, then the next level under its rows.
 */
const attach = (
	tables: RelationTables,
	relations: Record<string, Record<string, Relation> | undefined>,
	key: string,
	rows: ReadonlyArray<Row>,
	level: Level,
	crossTenant: boolean,
): Effect.Effect<ReadonlyArray<Row>, FindError, Database> =>
	Effect.gen(function* () {
		const names = Object.entries(level.with ?? {}).filter(([, spec]) => spec !== undefined)
		if (names.length === 0) return rows
		const db = yield* Database
		const parent = tables[key]!
		const loaded: Record<string, Map<unknown, Array<Row>>> = {}
		for (const [name, spec] of names) {
			const relation = relations[key]?.[name]
			if (relation === undefined) {
				return yield* Effect.die(new Error(`findMany: ${key} has no relation named ${name}`))
			}
			const target = tables[relation.target]!
			const nested: Level = spec === true ? {} : (spec as Level)
			const keys = distinct(rows.map((row) => row[relation.from]))
			let children: ReadonlyArray<Row> = []
			if (keys.length > 0) {
				// The child level keeps the tenant its parents were read for: when the
				// parent rows all carry one tenant, the child query pins its own tenant
				// column to it, so its scope is proved like any other query's.
				const tenants =
					parent.tenantColumn !== undefined && target.tenantColumn !== undefined
						? distinct(rows.map((row) => row[parent.tenantColumn!]))
						: []
				const tenantColumn = target.tenantColumn
				const query = levelQuery(
					target,
					nested,
					($) => [
						$[relation.to].in_(...keys),
						tenantColumn !== undefined && tenants.length === 1 ? $[tenantColumn].eq(tenants[0]) : undefined,
					],
					crossTenant,
				)
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
		return rows.map((row) => {
			const out: Row = { ...row }
			for (const [name] of names) {
				const relation = relations[key]![name]!
				const group = loaded[name]!.get(row[relation.from]) ?? []
				out[name] = relation.kind === "many" ? group : (group[0] ?? null)
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
 * ```ts
 * Db.findMany(schema.users, { where: ($) => [$.orgId.eq(orgId)], with: { posts: { with: { author: true } } } })
 * ```
 */
export const findMany: {
	<Tables extends RelationTables, R, K extends keyof Tables & string>(
		table: RelationalTable<Tables, R, K>,
	): Effect.Effect<ReadonlyArray<FindManyRow<Tables, R, K, {}>>, FindError, Database>
	<Tables extends RelationTables, R, K extends keyof Tables & string, const O extends FindManyOptions<Tables, R, K>>(
		table: RelationalTable<Tables, R, K>,
		options: O,
	): Effect.Effect<ReadonlyArray<FindManyRow<Tables, R, K, WithIn<O>>>, FindError, Database>
} = (table: RelationalTable<RelationTables, unknown, string>, options?: FindManyOptions<RelationTables, unknown, string>) =>
	Effect.gen(function* () {
		const level = (options ?? {}) as Level & { readonly crossTenant?: boolean }
		const crossTenant = level.crossTenant === true
		const db = yield* Database
		const rows = (yield* db.run(levelQuery(table.table, level, () => [], crossTenant) as any)) as ReadonlyArray<Row>
		return yield* attach(table.tables, table.relations as any, table.key, rows, level, crossTenant)
	}) as any

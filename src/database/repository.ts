// A repository derived from a table: insert, update, findById and delete, the
// plain CRUD `SqlModel.makeRepository` gives a `Model.Class`, built from an
// effect-orm table and its `tableSchemas` row types instead.
//
// A table with a tenant column gets a tenant repository: every method takes
// the tenant first and pins every statement to it, so a call cannot read or
// write another tenant's rows, and each statement compiles as
// `"single-tenant"` for `requireTenantScope`. See docs/database.md#repositories.

import { Effect, Option } from "effect"
import type { CompiledQueryDecodeError } from "../ch/compile"
import { QueryBuilderDefect, type QueryBuilderError } from "../ch/errors"
import { insertInto } from "../ch/insert"
import { from } from "../ch/query"
import type { SelectRowOf, Table } from "../ch/table"
import type { TableSchemas } from "../ch/table-schemas"
import type { ColumnDefs } from "../ch/types"
import { deleteFrom, update as updateTable } from "../ch/update"
import { Database, type DatabaseApi } from "./database"
import type { DatabaseError } from "./errors"

type AnyTable = Table<string, ColumnDefs, any, any>

type Simplify<A> = { [K in keyof A]: A[K] } & {}

/** What a repository method fails with: the errors of `Database.run`. */
export type RepositoryError = DatabaseError | QueryBuilderError | CompiledQueryDecodeError

/** CRUD over a table without a tenant column. */
export interface Repository<Row, Id, Insert, Update> {
	/** Insert a row and return it as stored, with its defaults. Needs RETURNING (Postgres). */
	readonly insert: (row: Insert) => Effect.Effect<Row, RepositoryError>
	/** Insert a row. */
	readonly insertVoid: (row: Insert) => Effect.Effect<void, RepositoryError>
	/** Change the row with this id and return it, or `None` when there is no such row. Needs RETURNING (Postgres). */
	readonly update: (id: Id, patch: Update) => Effect.Effect<Option.Option<Row>, RepositoryError>
	/** Change the row with this id, if there is one. */
	readonly updateVoid: (id: Id, patch: Update) => Effect.Effect<void, RepositoryError>
	/** The row with this id, or `None`. */
	readonly findById: (id: Id) => Effect.Effect<Option.Option<Row>, RepositoryError>
	/** Delete the row with this id, if there is one. */
	readonly delete: (id: Id) => Effect.Effect<void, RepositoryError>
}

/**
 * CRUD over a table with a tenant column. Every method takes the tenant first
 * and reads or writes only that tenant's rows: an insert writes the tenant
 * column itself, and every other statement filters on it.
 */
export interface TenantRepository<Row, Tenant, Id, Insert, Update> {
	readonly insert: (tenant: Tenant, row: Insert) => Effect.Effect<Row, RepositoryError>
	readonly insertVoid: (tenant: Tenant, row: Insert) => Effect.Effect<void, RepositoryError>
	readonly update: (tenant: Tenant, id: Id, patch: Update) => Effect.Effect<Option.Option<Row>, RepositoryError>
	readonly updateVoid: (tenant: Tenant, id: Id, patch: Update) => Effect.Effect<void, RepositoryError>
	readonly findById: (tenant: Tenant, id: Id) => Effect.Effect<Option.Option<Row>, RepositoryError>
	readonly delete: (tenant: Tenant, id: Id) => Effect.Effect<void, RepositoryError>
}

type InsertOf<T> = TableSchemas<T>["insert"]["Type"]
type UpdateOf<T> = TableSchemas<T>["update"]["Type"]

/**
 * The repository `makeRepository` builds for a table: a `TenantRepository`
 * when `TenantColumn` is given, a `Repository` otherwise. Inserts take the
 * table's `tableSchemas(table).insert` row, without the tenant column; updates
 * take its `update` row, without the id and the tenant column.
 */
export type RepositoryOf<T, Id extends string, TenantColumn extends string = never> = [TenantColumn] extends [never]
	? Repository<SelectRowOf<T>, SelectRowOf<T>[Id & keyof SelectRowOf<T>], InsertOf<T>, Simplify<Omit<UpdateOf<T>, Id>>>
	: TenantRepository<
			SelectRowOf<T>,
			SelectRowOf<T>[TenantColumn & keyof SelectRowOf<T>],
			SelectRowOf<T>[Id & keyof SelectRowOf<T>],
			Simplify<Omit<InsertOf<T>, TenantColumn>>,
			Simplify<Omit<UpdateOf<T>, Id | TenantColumn>>
		>

export interface RepositoryOptions<Id extends string, TenantColumn extends string> {
	/** The column `findById`, `update` and `delete` look a row up by. */
	readonly idColumn: Id
	/**
	 * The table's tenant column. Required when the table declares one, and
	 * refused when it does not: a repository over a tenant table that is not
	 * pinned to a tenant is a defect when it is built.
	 */
	readonly tenantColumn?: TenantColumn | undefined
}

type Untyped = Repository<any, unknown, Record<string, unknown>, Record<string, unknown>>

const withoutKeys = (record: Record<string, unknown>, keys: ReadonlyArray<string | undefined>) =>
	Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)))

/** The untyped CRUD of a table, every statement pinned to `tenant` when `tenantColumn` is set. */
const crud = (
	db: DatabaseApi,
	table: AnyTable,
	idColumn: string,
	tenantColumn: string | undefined,
	tenant: unknown,
): Untyped => {
	// Both run `Database.run`, typed for queries written in the source; these are built at runtime.
	const run = db.run as (query: unknown) => Effect.Effect<ReadonlyArray<any>, RepositoryError>
	const write = db.run as (query: unknown) => Effect.Effect<ReadonlyArray<unknown>, RepositoryError>
	const byId =
		(id: unknown) =>
		($: any): ReadonlyArray<unknown> =>
			tenantColumn === undefined ? [$[idColumn].eq(id)] : [$[tenantColumn].eq(tenant), $[idColumn].eq(id)]
	const row = (input: Record<string, unknown>) =>
		tenantColumn === undefined ? input : { ...withoutKeys(input, [tenantColumn]), [tenantColumn]: tenant }
	const patch = (input: Record<string, unknown>) => withoutKeys(input, [idColumn, tenantColumn])
	const insert = (input: Record<string, unknown>) => (insertInto(table) as any).values(row(input))
	// A ClickHouse UPDATE is a mutation and its DELETE a lightweight delete: both
	// wait here, so a `findById` after them reads what they wrote.
	const settled = db.dialect.clauses.writeSettings === true
	const change = (id: unknown, input: Record<string, unknown>) => {
		const query = (updateTable(table) as any).set(patch(input)).where(byId(id))
		return settled && db.dialect.clauses.alterTableUpdate === true ? query.settings({ mutations_sync: 2 }) : query
	}
	const remove = (id: unknown) => {
		const query = (deleteFrom(table) as any).where(byId(id))
		return settled ? query.settings({ lightweight_deletes_sync: 2 }) : query
	}

	return {
		// An INSERT without ON CONFLICT returns its row or fails, so no row is a defect.
		insert: (input) => Effect.flatMap(run(insert(input).returning()), (rows) => Effect.orDie(Effect.fromNullishOr(rows[0]))),
		insertVoid: (input) => Effect.asVoid(write(insert(input))),
		update: (id, input) => Effect.map(run(change(id, input).returning()), (rows) => Option.fromNullishOr(rows[0])),
		updateVoid: (id, input) => Effect.asVoid(write(change(id, input))),
		findById: (id) =>
			Effect.map(run((from(table) as any).select().where(byId(id)).limit(1)), (rows) => Option.fromNullishOr(rows[0])),
		delete: (id) => Effect.asVoid(write(remove(id))),
	}
}

/**
 * Build the CRUD repository of a table on the `Database` in context, as
 * `SqlModel.makeRepository` does for a `Model.Class`:
 *
 * ```ts
 * const tickets = yield* Db.makeRepository(Tickets, { idColumn: "id", tenantColumn: "org" })
 * const ticket = yield* tickets.insert("acme", { title: "Board" })
 * yield* tickets.findById("acme", ticket.id) // Option.some(ticket)
 * yield* tickets.findById("other", ticket.id) // Option.none()
 * ```
 */
export const makeRepository = <
	T extends AnyTable,
	const Id extends keyof T["columns"] & string,
	const TenantColumn extends Exclude<keyof T["columns"] & string, Id> = never,
>(
	table: T,
	options: RepositoryOptions<Id, TenantColumn>,
): Effect.Effect<RepositoryOf<T, Id, TenantColumn>, never, Database> =>
	Effect.gen(function* () {
		const db = yield* Database
		const tenantColumn: string | undefined = options.tenantColumn
		if (table.tenantColumn !== tenantColumn) {
			return yield* Effect.die(
				new QueryBuilderDefect({
					message:
						table.tenantColumn === undefined
							? `makeRepository(${table.name}): the table has no tenant column, so tenantColumn ${JSON.stringify(tenantColumn)} pins nothing`
							: `makeRepository(${table.name}): the table's tenant column is ${JSON.stringify(table.tenantColumn)}; pass tenantColumn: ${JSON.stringify(table.tenantColumn)} so every method is pinned to one tenant`,
				}),
			)
		}
		const scoped = (tenant: unknown) => crud(db, table, options.idColumn, tenantColumn, tenant)
		if (tenantColumn === undefined) return scoped(undefined) as RepositoryOf<T, Id, TenantColumn>
		const repository: TenantRepository<any, unknown, unknown, Record<string, unknown>, Record<string, unknown>> = {
			insert: (tenant, row) => scoped(tenant).insert(row),
			insertVoid: (tenant, row) => scoped(tenant).insertVoid(row),
			update: (tenant, id, patch) => scoped(tenant).update(id, patch),
			updateVoid: (tenant, id, patch) => scoped(tenant).updateVoid(id, patch),
			findById: (tenant, id) => scoped(tenant).findById(id),
			delete: (tenant, id) => scoped(tenant).delete(id),
		}
		return repository as RepositoryOf<T, Id, TenantColumn>
	})

// Request batching over Effect's `RequestResolver`: N concurrent lookups by a
// key become one `WHERE key IN (...)` statement, run with `Database.run`, so
// rows decode through the query's own row schema and `requireTenantScope`
// checks the statement that is sent. See docs/database.md#batching-lookups.
//
// Effect's `SqlResolver` keys batches by the `SqlClient` transaction found in
// context. A `Database` does not need a `SqlClient` in context, so the batch
// key here is built from what `Database` itself uses: the `Database` service,
// its open transaction, the client transaction when a client is in context,
// and the params the lookup was given.

import { Cause, Context, Effect, Exit, MutableHashMap, Request, RequestResolver } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import type { NonEmptyArray } from "effect/Array"
import type { CompiledQueryDecodeError } from "../ch/compile"
import { QueryBuilderError } from "../ch/errors"
import type { ParamsSatisfied } from "../ch/expr"
import type { CHQuery, NeedsSelect } from "../ch/query"
import type { ColumnDefs } from "../ch/types"
import { Database, TransactionOpen } from "./database"
import type { DatabaseError } from "./errors"

/** The errors of one batched lookup, besides `NoSuchElementError` for `findById`. */
export type LookupError = DatabaseError | QueryBuilderError | CompiledQueryDecodeError

/**
 * Look up one row by its key. Concurrent calls in one batch become one
 * statement. Call it directly when the query has no `param.*` markers;
 * otherwise give the params first with `with`.
 */
export interface FindById<K, A, P> {
	(key: K & ParamsSatisfied<P, {}>): Effect.Effect<A, Cause.NoSuchElementError | LookupError, Database>
	/** The lookup for these params. Lookups with equal params batch together. */
	readonly with: <const Given extends object>(
		params: Given & ParamsSatisfied<P, Given>,
	) => (key: K) => Effect.Effect<A, Cause.NoSuchElementError | LookupError, Database>
}

/**
 * Look up every row with a key. Concurrent calls in one batch become one
 * statement. A key with no rows gives an empty array.
 */
export interface FindAllBy<K, A, P> {
	(key: K & ParamsSatisfied<P, {}>): Effect.Effect<ReadonlyArray<A>, LookupError, Database>
	/** The lookup for these params. Lookups with equal params batch together. */
	readonly with: <const Given extends object>(
		params: Given & ParamsSatisfied<P, Given>,
	) => (key: K) => Effect.Effect<ReadonlyArray<A>, LookupError, Database>
}

export interface LookupOptions<Key extends string> {
	/** The column to look up by. The query must select it under its own name. */
	readonly key: Key
}

/** The params of a query, `never` when it has none. */
type NoAny<P> = 0 extends 1 & P ? never : P

interface LookupRequest extends Request.Request<ReadonlyArray<Record<string, unknown>>, LookupError, Database> {
	readonly key: unknown
	readonly params: object
}

const LookupRequest = Request.of<LookupRequest>()

// Context objects get a number, so a batch key is a value `Equal` can compare
// without marking the objects themselves as compared by reference.
const ids = new WeakMap<object, number>()
let nextId = 0
const idOf = (value: object | undefined): number => {
	if (value === undefined) return 0
	let id = ids.get(value)
	if (id === undefined) {
		id = ++nextId
		ids.set(value, id)
	}
	return id
}

const contextKey = (context: Context.Context<never>, params: object): ReadonlyArray<unknown> => {
	const client = Context.getOrUndefined(context, SqlClient.SqlClient)
	const connection = client === undefined ? undefined : Context.getOrUndefined(context, client.transactionService)
	return [
		idOf(Context.getOrUndefined(context, Database)),
		idOf(Context.getOrUndefined(context, TransactionOpen)),
		idOf(connection),
		params,
	]
}

const resolverFor = (query: CHQuery<any, any, any, any, any>, key: string) => {
	// One stable key object per distinct batch key, dropped when its batch runs.
	const keys = MutableHashMap.empty<ReadonlyArray<unknown>, object>()
	return RequestResolver.makeWith<LookupRequest>({
		batchKey: (entry) => {
			const value = contextKey(entry.context as Context.Context<never>, entry.request.params)
			const found = MutableHashMap.get(keys, value)
			if (found._tag === "Some") return found.value
			const stable = { value }
			MutableHashMap.set(keys, value, stable)
			return stable
		},
		delay: Effect.yieldNow,
		collectWhile: () => true,
		runAll: (entries: NonEmptyArray<Request.Entry<LookupRequest>>, batchKey) =>
			Effect.gen(function* () {
				MutableHashMap.remove(keys, (batchKey as { value: ReadonlyArray<unknown> }).value)
				const state = query._state
				if (state.limitValue !== undefined || state.offsetValue !== undefined) {
					return yield* new QueryBuilderError({
						code: "InvalidArguments",
						message: "a batched lookup cannot have limit or offset: they would apply to the whole batch, not to each key",
					})
				}
				const wanted = MutableHashMap.empty<unknown, true>()
				for (const entry of entries) MutableHashMap.set(wanted, entry.request.key, true)
				const values = Array.from(MutableHashMap.keys(wanted))
				const db = yield* Database
				const rows = yield* db.run(
					query.where(($: any) => [$[key].in_(...values)]) as never,
					entries[0].request.params as never,
				)
				const byKey = MutableHashMap.empty<unknown, Array<Record<string, unknown>>>()
				for (const row of rows as ReadonlyArray<Record<string, unknown>>) {
					const group = MutableHashMap.get(byKey, row[key])
					if (group._tag === "Some") group.value.push(row)
					else MutableHashMap.set(byKey, row[key], [row])
				}
				for (const entry of entries) {
					const group = MutableHashMap.get(byKey, entry.request.key)
					entry.completeUnsafe(Exit.succeed(group._tag === "Some" ? group.value : []))
				}
			}).pipe(Effect.provideContext(entries[0].context)),
	})
}

const lookup = <A>(
	query: CHQuery<any, any, any, any, any>,
	key: string,
	pick: (rows: ReadonlyArray<Record<string, unknown>>) => Effect.Effect<A, Cause.NoSuchElementError>,
) => {
	const resolver = resolverFor(query, key)
	const withParams =
		(params: object) =>
		(value: unknown): Effect.Effect<A, Cause.NoSuchElementError | LookupError, Database> =>
			Effect.flatMap(Effect.request(LookupRequest({ key: value, params }), resolver), pick)
	return Object.assign(withParams({}), { with: withParams })
}

/**
 * A batched lookup of one row by `key`. Concurrent calls that share a batch
 * (same `Database`, same transaction, same params) send one statement:
 * `query` with `key IN (...)` added to its WHERE. Rows decode as `run`
 * decodes them. A key with no row fails with `NoSuchElementError`; with
 * several, the first one wins.
 *
 * Tenant scope comes from `query`: filter the tenant column there, with a
 * value or a `param.*`, and `requireTenantScope` checks each batch statement.
 * Lookups with different params never share a batch, so one statement never
 * reads two tenants.
 */
export const findById = <
	Cols extends ColumnDefs,
	Output extends Record<string, any>,
	P,
	const Key extends keyof Cols & keyof Output & string,
>(
	query: CHQuery<Cols, Output, any, any, P> & NeedsSelect<Output>,
	options: LookupOptions<Key>,
): FindById<Output[Key], Output, NoAny<P>> =>
	lookup(query, options.key, (rows) =>
		rows.length === 0 ? Effect.fail(new Cause.NoSuchElementError()) : Effect.succeed(rows[0]),
	) as never

/**
 * A batched lookup of every row with `key`, such as the children of a parent.
 * Batches as `findById` does. A key with no rows gives an empty array.
 */
export const findAllBy = <
	Cols extends ColumnDefs,
	Output extends Record<string, any>,
	P,
	const Key extends keyof Cols & keyof Output & string,
>(
	query: CHQuery<Cols, Output, any, any, P> & NeedsSelect<Output>,
	options: LookupOptions<Key>,
): FindAllBy<Output[Key], Output, NoAny<P>> => lookup(query, options.key, Effect.succeed) as never

// Client-side defaults
//
// A Postgres column's `defaultFn` and `onUpdate` are Effects. `fillDefaults`
// runs them into an insert's rows or an update's SET, so the write that
// `compile` sees already has every value. `Database.run` calls it first; a
// write compiled without it, that still lacks a client default, is a defect.
// Running here, and not in `compile`, keeps `compile` free of requirements.

import { Effect } from "effect"
import { isInsert, type AnyInsert, type CHInsert } from "./insert"
import type { ClientDefaults } from "./table"
import { isUpdate, type CHUpdate } from "./update"

/** What a write's client defaults need to run: `never` for any other runnable. */
export type RequirementsOf<W> = W extends { readonly _phantom?: { readonly requirements: infer R } } ? R : never

type Row = Readonly<Record<string, unknown>>

/** The values a row leaves out, each from its Effect, in table order. */
const fillRow = (row: Row, defaults: ClientDefaults["insert"]): Effect.Effect<Row, never, any> => {
	const missing = Object.entries(defaults).filter(([column]) => row[column] === undefined)
	if (missing.length === 0) return Effect.succeed(row)
	return Effect.map(
		Effect.forEach(missing, ([column, effect]) => Effect.map(effect, (value) => [column, value] as const)),
		(filled) => ({ ...row, ...Object.fromEntries(filled) }),
	)
}

/**
 * Run the client defaults of a write's table: each `defaultFn` once for every
 * row of an insert that leaves its column out (an `onUpdate` stands in for a
 * column without a default), and each `onUpdate` once for an update that does
 * not set its column. A given value, `null` included, is kept. Any other
 * runnable, and an `INSERT ... SELECT`, comes back unchanged.
 *
 * `Database.run` does this itself. Call it before `compile` when you compile a
 * write yourself.
 */
export const fillDefaults = <W>(write: W): Effect.Effect<W, never, RequirementsOf<W>> => {
	if (isInsert(write)) return fillInsert(write) as Effect.Effect<any, never, any>
	if (isUpdate(write)) return fillUpdate(write) as Effect.Effect<any, never, any>
	return Effect.succeed(write)
}

const fillInsert = (insert: AnyInsert): Effect.Effect<AnyInsert, never, any> => {
	const defaults = insert._state.table.clientDefaults?.insert
	const rows = insert._state.rows
	if (defaults === undefined || rows === undefined) return Effect.succeed(insert)
	return Effect.map(Effect.forEach(rows, (row) => fillRow(row, defaults)), (filled) =>
		// Unchanged when no row left a client default out.
		filled.every((row, index) => row === rows[index])
			? insert
			: ((insert as CHInsert<any, any, any, any, any, any>).values(filled as never) as AnyInsert),
	)
}

const fillUpdate = (update: CHUpdate<any, any, any, any, any, any>): Effect.Effect<CHUpdate<any, any, any, any, any, any>, never, any> => {
	const defaults = update._state.table.clientDefaults?.update
	const set = update._state.set
	if (defaults === undefined || set === undefined || Object.keys(defaults).length === 0) return Effect.succeed(update)
	// A SET record says which columns it writes; a callback says so only when
	// compiled, so every `onUpdate` runs and the callback's own values win.
	const given = typeof set === "function" ? {} : (set as Row)
	return Effect.map(fillRow(given, defaults), (filled) => {
		const added = Object.fromEntries(Object.entries(filled).filter(([column]) => given[column] === undefined))
		const next =
			typeof set === "function"
				? ($: any) => {
						const record = set($) as Row
						return { ...record, ...Object.fromEntries(Object.entries(added).filter(([column]) => record[column] === undefined)) }
					}
				: { ...set, ...added }
		return update.set(next as never) as CHUpdate<any, any, any, any, any, any>
	})
}

// What a clause turned out to contain, learned while rendering it.
//
// Fragments are opaque until they render, so the only place to learn whether a
// SELECT expression aggregates, or which columns it reads outside an aggregate,
// is the render itself. `compile` renders each clause under `track` and reads
// the result; column identifiers and the builder's own functions report into
// it as they render.
//
// Only what the builder can vouch for is counted. A fragment it did not build
// (a `rawExpr`, a `sql` template, a function a caller declared with `makeExpr`)
// renders as opaque: nothing inside it is counted, so an unknown function is
// never mistaken for a scalar one wrapping a bare column. The checks built on
// this can miss an error inside opaque SQL, never invent one.
//
// Rendering is synchronous, and every entry point saves and restores, so a
// nested compile (a subquery) and a callback that throws leave no state behind.

/** What one tracked render found. */
export interface RenderTrack {
	/** An aggregate function was rendered outside any window. */
	aggregate: boolean
	/** Columns read outside any aggregate, window or opaque fragment, as
	 *  `qualifier.name` (or `name`). */
	readonly columns: Set<string>
}

interface State {
	readonly track: RenderTrack
	aggregateDepth: number
	/** Inside a window or an opaque fragment: nothing is counted. */
	hiddenDepth: number
}

let current: State | undefined

/** Render `body` with a fresh track, returning both. */
export function track<A>(body: () => A): [A, RenderTrack] {
	const previous = current
	const state: State = { track: { aggregate: false, columns: new Set() }, aggregateDepth: 0, hiddenDepth: 0 }
	current = state
	try {
		return [body(), state.track]
	} finally {
		current = previous
	}
}

/** Render `body` with no track: a nested query's columns are its own. */
export function untracked<A>(body: () => A): A {
	const previous = current
	current = undefined
	try {
		return body()
	} finally {
		current = previous
	}
}

/** A column identifier rendered. */
export function noteColumn(name: string): void {
	if (current !== undefined && current.aggregateDepth === 0 && current.hiddenDepth === 0) current.track.columns.add(name)
}

/** Render an aggregate call: it marks the clause, and its arguments are not bare columns. */
export function inAggregate(render: () => string): string {
	const state = current
	if (state === undefined) return render()
	if (state.hiddenDepth === 0) state.track.aggregate = true
	state.aggregateDepth++
	try {
		return render()
	} finally {
		state.aggregateDepth--
	}
}

/** Render a window (`… OVER (…)`) or SQL the builder did not write: nothing inside is counted. */
export function hidden(render: () => string): string {
	const state = current
	if (state === undefined) return render()
	state.hiddenDepth++
	try {
		return render()
	} finally {
		state.hiddenDepth--
	}
}

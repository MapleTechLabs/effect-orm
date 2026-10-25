// Predicate facts
//
// A condition in a query's top-level WHERE list is true for every row the
// query returns. Some conditions prove more than their own truth: `x IS NOT
// NULL` and `x = y` are only true when `x` is not NULL. A *fact* records that
// proof for one column of a joined source, so the builder can type and decode
// that column without `| null` once the WHERE list holds it.
//
// The type side rides on `Condition`'s second type parameter; this module is
// the runtime side, which `compile` reads to narrow the row schema the same way.
// Only an AND keeps a fact: `.and`, `and(…)` and the WHERE list itself. An OR,
// a NOT, or an optional `when` branch proves nothing about every row.

import type { Condition } from "./expr"

/** A joined column proven not NULL: the join alias and the column key. */
export interface NotNullFact<Source extends string = string, Column extends string = string> {
	readonly source: Source
	readonly column: Column
}

const facts = new WeakMap<Condition, ReadonlyArray<NotNullFact>>()

/** The not-NULL facts a condition proves; none for one that proves nothing. */
export const notNullFactsOf = (condition: Condition): ReadonlyArray<NotNullFact> => facts.get(condition) ?? []

/** Record what `condition` proves. Returns it, for use in an expression. */
export const markNotNullFacts = <A extends Condition>(condition: A, proven: ReadonlyArray<NotNullFact>): A => {
	if (proven.length > 0) facts.set(condition, proven)
	return condition
}

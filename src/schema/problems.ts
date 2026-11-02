// Definition problems. A definition never throws: it records what is wrong with
// it, and `entitiesOf` (or `buildProject`) fails with every problem at once.

import { Schema } from "effect"
import { collectFailures } from "../ch/failure"

export const DefinitionProblem = Schema.Struct({ object: Schema.String, message: Schema.String })
export type DefinitionProblem = typeof DefinitionProblem.Type

/** A schema that cannot be turned into DDL: every problem its definitions recorded. */
export class SchemaDefinitionError extends Schema.TaggedError<SchemaDefinitionError>()(
	"@maple-dev/effect-orm/SchemaDefinitionError",
	{ problems: Schema.Array(DefinitionProblem), message: Schema.String },
) {}

export const definitionError = (problems: ReadonlyArray<DefinitionProblem>): SchemaDefinitionError =>
	new SchemaDefinitionError({
		problems,
		message: problems.map((problem) => `${problem.object}: ${problem.message}`).join("; "),
	})

/** Problems collected while one definition is built. */
export type ProblemSink = Array<DefinitionProblem>

export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

export const checkIdentifier = (problems: ProblemSink, object: string, name: string): void => {
	if (!IDENTIFIER.test(name)) {
		problems.push({ object, message: `${JSON.stringify(name)} is not a plain identifier ([A-Za-z_][A-Za-z0-9_]*)` })
	}
}

/** Build a definition, adding any failure its rendering recorded to its `problems`. */
/**
 * Two columns of one table with the same SQL name. `ignoreCase` where the
 * database compares names without case (SQLite), so `Id` and `id` collide.
 */
export const checkDistinctNames = (
	problems: ProblemSink,
	table: string,
	columns: ReadonlyArray<readonly [key: string, sqlName: string]>,
	options: { readonly ignoreCase: boolean },
): void => {
	const seen = new Map<string, string>()
	for (const [key, sqlName] of columns) {
		const folded = options.ignoreCase ? sqlName.toLowerCase() : sqlName
		const other = seen.get(folded)
		if (other !== undefined) {
			problems.push({ object: `${table}.${key}`, message: `${sqlName} has the same SQL name as ${other}${options.ignoreCase ? " (names compare without case)" : ""}` })
		} else seen.set(folded, key)
	}
}

/** A key (primary key, index) that lists a column more than once. */
export const checkNoRepeats = (problems: ProblemSink, object: string, keys: ReadonlyArray<string>): void => {
	const repeats = keys.filter((key, i) => keys.indexOf(key) !== i)
	if (repeats.length > 0) problems.push({ object, message: `${[...new Set(repeats)].join(", ")} is listed more than once` })
}

export const withRenderProblems = <O extends { readonly problems: ReadonlyArray<DefinitionProblem> }>(object: string, build: () => O): O => {
	const { value, failures } = collectFailures(build)
	return failures.length === 0
		? value
		: { ...value, problems: [...value.problems, ...failures.map((failure) => ({ object, message: failure.message }))] }
}

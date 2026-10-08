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
export const withRenderProblems = <O extends { readonly problems: ReadonlyArray<DefinitionProblem> }>(object: string, build: () => O): O => {
	const { value, failures } = collectFailures(build)
	return failures.length === 0
		? value
		: { ...value, problems: [...value.problems, ...failures.map((failure) => ({ object, message: failure.message }))] }
}

// Compile failures. Nothing in the builder throws: a check that fails records its
// error in the slot the enclosing compile opened and returns placeholder SQL, and
// the compile entry point turns that slot into the Effect's outcome.

import { Effect } from "effect"
import { QueryBuilderDefect, type QueryBuilderError } from "./errors"

export type CompileFailure = QueryBuilderError | QueryBuilderDefect

// Compilation is synchronous, so one slot per outermost compile is enough.
let slot: Array<CompileFailure> | undefined

/** Record `failure` for the enclosing compile, and carry on with `placeholder`. */
export const fail = <A>(failure: CompileFailure, placeholder: A): A => {
	slot?.push(failure)
	return placeholder
}

/** Run `body`, collecting what it records. A nested call leaves them to the outermost one. */
export function collectFailures<A>(body: () => A): { readonly value: A; readonly failures: ReadonlyArray<CompileFailure> } {
	if (slot !== undefined) return { value: body(), failures: [] }
	const failures: Array<CompileFailure> = []
	slot = failures
	try {
		return { value: body(), failures }
	} finally {
		slot = undefined
	}
}

/**
 * `body`'s result as an Effect. A recorded `QueryBuilderError` is a typed failure;
 * a `QueryBuilderDefect` is a bug in the query's source, so it dies.
 */
export const compiled = <A>(body: () => A): Effect.Effect<A, QueryBuilderError> =>
	Effect.suspend(() => {
		const { value, failures } = collectFailures(body)
		const defect = failures.find((failure) => failure instanceof QueryBuilderDefect)
		// A defect is a call no input could make right; see `errors.ts`.
		// oxlint-disable-next-line maple/no-effect-die
		if (defect !== undefined) return Effect.die(defect)
		const error = failures.find((failure): failure is QueryBuilderError => !(failure instanceof QueryBuilderDefect))
		return error === undefined ? Effect.succeed(value) : Effect.fail(error)
	})

/** {@link compiled}, run at once: the unsafe edge, which throws the recorded failure. */
export const compiledUnsafe = <A>(body: () => A): A => Effect.runSync(compiled(body))

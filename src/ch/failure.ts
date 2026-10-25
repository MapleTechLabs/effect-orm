// Compile failures. Nothing in the builder throws: a check that fails records its
// error in the slot the enclosing compile opened and returns placeholder SQL, and
// the compile entry point turns that slot into the Effect's outcome.

import { Context, Effect } from "effect"
import { fiberLocal, runSyncHere } from "../sql/fiber-local"
import { QueryBuilderDefect, type QueryBuilderError } from "./errors"

export type CompileFailure = QueryBuilderError | QueryBuilderDefect

// One slot per outermost compile, kept in the compiling fiber's context (see
// `fiber-local.ts`).
const slot = fiberLocal(
	Context.Reference<Array<CompileFailure> | undefined>("@maple-dev/effect-orm/internal/CompileFailures", {
		defaultValue: () => undefined,
	}),
)

/** Record `failure` for the enclosing compile, and carry on with `placeholder`. */
export const fail = <A>(failure: CompileFailure, placeholder: A): A => {
	slot.get()?.push(failure)
	return placeholder
}

/** Run `body`, collecting what it records. A nested call leaves them to the outermost one. */
export function collectFailures<A>(body: () => A): { readonly value: A; readonly failures: ReadonlyArray<CompileFailure> } {
	if (slot.get() !== undefined) return { value: body(), failures: [] }
	const failures: Array<CompileFailure> = []
	return { value: slot.with(failures, body), failures }
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

/**
 * {@link compiled}, run at once: the unsafe edge, which throws the recorded failure.
 * It runs in the calling fiber's context, so a compile nested in another keeps its state.
 */
export const compiledUnsafe = <A>(body: () => A): A => runSyncHere(compiled(body))

// Feedback: what a search learns from running one input.
//
// A coverage-guided search keeps an input when it did something no earlier
// input did. "Something new" is whatever the provided `Feedback` counts: V8
// code coverage (`Coverage.layer`), the spans an input opened
// (`Spans.layer`), or nothing, which is the default and makes every search
// behave like random search.
import { Context, Effect } from "effect"

/** One file's coverage so far. */
export interface FileSummary {
	readonly file: string
	/** Functions and branches reached / known. */
	readonly covered: number
	readonly total: number
	/** Functions no input reached, as `name:line`. */
	readonly unreached: ReadonlyArray<string>
}

export interface FeedbackSummary {
	readonly kind: string
	readonly covered: number
	/** How many there are to reach, or `undefined` when only what was reached is known. */
	readonly total: number | undefined
	readonly files: ReadonlyArray<FileSummary>
}

export interface FeedbackService {
	/**
	 * Forgets what has happened up to now. Called once, before a check's first
	 * input: what ran earlier in the process is not this check's doing, and must
	 * neither count as reached nor make its own first inputs look old.
	 */
	readonly begin: Effect.Effect<void>
	/** How many new things happened since the last call. They count as seen from now on. */
	readonly novelty: Effect.Effect<number>
	/**
	 * How many new things happened since the last call, without counting them as
	 * seen. Reading feedback can cost more than running an input, so a search runs
	 * a batch of inputs, peeks once, and only when something was new runs the
	 * batch again one input at a time to find which one did it.
	 *
	 * What one peek saw counts as seen at the next peek, found again or not:
	 * something no single input reproduces (it took the whole batch, or it was
	 * the runtime's doing) must not make every later batch look new.
	 */
	readonly peek: Effect.Effect<number>
	/** What has been reached so far, for the report. */
	readonly summary: Effect.Effect<FeedbackSummary | undefined>
}

/** No feedback: nothing is ever new. */
export const none: FeedbackService = { begin: Effect.void, novelty: Effect.succeed(0), peek: Effect.succeed(0), summary: Effect.succeed(undefined) }

/** The feedback the current search reads. Defaults to `none`. */
export const Feedback = Context.Reference<FeedbackService>("effect-prop/Feedback", { defaultValue: () => none })

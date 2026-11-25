// Searches: how a run chooses its next input.
//
// A search is a loop over the steps of a `Run`. The ones here differ in what
// they build the next input from: nothing (`random`), an input that reached new
// code (`coverage`), or the input with the best score so far (`target`,
// `slow`). Write your own the same way: `execute` while the run `wantsMore`.
import { Effect } from "effect"
import { Feedback, none } from "./Feedback"
import type { Run, Tested } from "./Prop"
import type { Choices, Rng } from "./Source"

export type Search<A, E = never, R = never> = (run: Run<A, E, R>) => Effect.Effect<void, never, R>

/** Every input fresh from the generator. */
export const random = <A, E, R>(run: Run<A, E, R>): Effect.Effect<void, never, R> =>
	Effect.gen(function* () {
		while (yield* run.wantsMore) yield* run.execute()
	})

/** What a mutation needs to know about an input: its choices and what each could have been. */
export interface Parent {
	readonly choices: Choices
	readonly bounds: ReadonlyArray<number>
}

const replacement = (rng: Rng, current: number, max: number): number => {
	const kind = rng.upTo(7)
	if (kind === 0) return 0
	if (kind === 1) return max
	if (kind === 2) return Math.min(max, current + 1)
	if (kind === 3) return Math.max(0, current - 1)
	return rng.upTo(max)
}

/**
 * A variation of `parent`: some choices replaced, a run of them removed or
 * repeated, the tail cut off (and drawn fresh when executed), or the tail of
 * `donor` grafted on. The generator makes a valid input of whatever comes out.
 */
export const mutate = (rng: Rng, parent: Parent, donor?: Parent): Array<number> => {
	const choices = [...parent.choices]
	const length = choices.length
	if (length === 0) return choices
	const at = rng.upTo(length - 1)
	switch (rng.upTo(donor === undefined || donor.choices.length === 0 ? 4 : 5)) {
		case 0:
		case 1: {
			// Most new behaviour is one decision away, so point edits get twice the weight.
			for (let edits = 1 + rng.upTo(2); edits > 0; edits--) {
				const i = rng.upTo(length - 1)
				choices[i] = replacement(rng, choices[i]!, parent.bounds[i] ?? choices[i]!)
			}
			return choices
		}
		case 2:
			return choices.slice(0, at)
		case 3: {
			choices.splice(at, 1 + rng.upTo(7))
			return choices
		}
		case 4: {
			const chunk = choices.slice(at, at + 1 + rng.upTo(7))
			choices.splice(at, 0, ...chunk)
			return choices
		}
		default:
			return [...choices.slice(0, at), ...donor!.choices.slice(rng.upTo(donor!.choices.length - 1))]
	}
}

/** Favours recent entries: they reached code the older ones did not. */
const pick = <T>(rng: Rng, pool: ReadonlyArray<T>): T => pool[pool.length - 1 - Math.floor(rng.float() ** 2 * pool.length)]!

/** How often a guided search runs a fresh input instead of a mutation: enough to keep finding new starting points. */
const EXPLORE = 0.2
/** The most inputs run between two readings of the feedback. */
const MAX_BATCH = 64

/**
 * Coverage-guided search: keeps every input the provided `Feedback` says did
 * something new, and builds most new inputs by mutating a kept one. Without a
 * `Feedback` nothing is ever new and this is random search, with a warning.
 *
 * Reading the feedback can cost more than running an input, so inputs run in
 * batches: one reading per batch, and only a batch that did something new is
 * run again input by input to find which. The batch grows while nothing is new
 * and shrinks when something is.
 */
export const coverage = <A, E, R>(run: Run<A, E, R>): Effect.Effect<void, never, R> =>
	Effect.gen(function* () {
		if ((yield* Feedback) === none) yield* Effect.logWarning("effect-prop: Search.coverage has no Feedback to read, so it searches at random; provide Coverage.layer or Spans.layer")
		const pool: Array<Tested<A, E>> = []
		const batch: Array<Tested<A, E>> = []
		let batchSize = 1
		const settle = Effect.fnUntraced(function* () {
			if ((yield* run.peek) === 0) {
				batchSize = Math.min(MAX_BATCH, batchSize * 2)
			} else {
				batchSize = Math.max(1, batchSize >> 1)
				for (const candidate of batch) {
					const observed = yield* run.observe(candidate)
					if (observed.novelty === 0) continue
					pool.push(observed)
					run.keep(observed)
				}
			}
			batch.length = 0
		})
		while (yield* run.wantsMore) {
			let tested: Tested<A, E>
			if (pool.length === 0 || run.rng.float() < EXPLORE) {
				tested = yield* run.execute()
			} else {
				const parent = pick(run.rng, pool)
				tested = yield* run.execute({ prefix: mutate(run.rng, parent, pick(run.rng, pool)), size: parent.size })
			}
			if (tested.verdict._tag !== "Discard") batch.push(tested)
			if (batch.length >= batchSize) yield* settle()
		}
		if (batch.length > 0) yield* settle()
	})

/**
 * Hill-climbing: mutates the highest-scoring input so far, and keeps a mutation
 * that scores at least as high. `score` defaults to what the property gave
 * `Prop.target`; an input with no score, or one that is not a number, is passed over.
 */
export const target =
	<A = any, E = any>(score: (tested: Tested<A, E>) => number | undefined = (tested) => tested.score) =>
	<A2 extends A, E2 extends E, R>(run: Run<A2, E2, R>): Effect.Effect<void, never, R> =>
		Effect.gen(function* () {
			let best: { readonly tested: Tested<A2, E2>; readonly score: number } | undefined
			while (yield* run.wantsMore) {
				const tested: Tested<A2, E2> =
					best === undefined || run.rng.float() < EXPLORE
						? yield* run.execute()
						: yield* run.execute({ prefix: mutate(run.rng, best.tested), size: best.tested.size })
				if (tested.verdict._tag === "Discard") continue
				const scored = score(tested)
				if (scored === undefined || Number.isNaN(scored)) continue
				if (best === undefined || scored >= best.score) {
					if (best === undefined || scored > best.score) run.keep(tested)
					best = { tested, score: scored }
				}
			}
		})

/** Steers toward the inputs the property takes longest on: for finding quadratic paths and hangs. */
export const slow: <A, E, R>(run: Run<A, E, R>) => Effect.Effect<void, never, R> = target((tested) => tested.durationMs)

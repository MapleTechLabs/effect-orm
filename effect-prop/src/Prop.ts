// Properties: an Effect that must hold for every value a generator builds.
//
// `check` runs a search over inputs, groups the failures it finds by what went
// wrong, shrinks one input per group, and returns a report. Each input runs in
// its own scope, so a property can acquire a fixture and trust it is released
// before the next input.
import { Cause, Config, Context, Duration, Effect, Exit, Formatter, Option, Random, Schema, type Scope } from "effect"
import { Feedback, type FeedbackSummary } from "./Feedback"
import * as Gen from "./Gen"
import { relativePath } from "./internal"
import { Regressions } from "./Regressions"
import type { Search } from "./Search"
import { random } from "./Search"
import { shrink } from "./Shrink"
import { type Choices, compareChoices, decodeReplay, Discard, encodeReplay, Rng, sizeAt, Source, type Span } from "./Source"

// What a property can say about the input it is running on

class CaseState {
	/** A set: an input counts once under a label, however often the property names it. */
	readonly labels = new Set<string>()
	score: number | undefined
	signature: string | undefined
}

const CurrentCase = Context.Reference<CaseState | undefined>("effect-prop/CurrentCase", { defaultValue: () => undefined })

/** Skips this input when `condition` is false. It counts as a discard, not a pass. */
export const assume = (condition: boolean, reason = "assumption not met"): Effect.Effect<void> =>
	condition ? Effect.void : Effect.die(new Discard(reason))

/** Counts this input under `name` in the report: how the generated inputs are distributed. */
export const label = (name: string): Effect.Effect<void> =>
	Effect.map(CurrentCase, (state) => {
		state?.labels.add(name)
	})

/** Counts this input under `name` when `condition` holds. */
export const classify = (condition: boolean, name: string): Effect.Effect<void> => (condition ? label(name) : Effect.void)

/** Scores this input. `Search.target` steers toward higher scores. */
export const target = (score: number): Effect.Effect<void> =>
	Effect.map(CurrentCase, (state) => {
		if (state !== undefined) state.score = score
	})

/**
 * Names the failure group this input belongs to if it fails. Without it a
 * failure is grouped by its error's `_tag`, or by where it was thrown; call
 * this when one assertion covers several causes.
 */
export const signature = (name: string): Effect.Effect<void> =>
	Effect.map(CurrentCase, (state) => {
		if (state !== undefined) state.signature = name
	})

// Results

export type Verdict<E> =
	| { readonly _tag: "Pass" }
	| { readonly _tag: "Discard"; readonly reason: string }
	| {
			readonly _tag: "Fail"
			/** The failure group: equal signatures are the same bug as far as the search can tell. */
			readonly signature: string
			readonly message: string
			/** The property's failure. Absent when it returned `false` or timed out. */
			readonly cause: Cause.Cause<E> | undefined
	  }

/** One input, run. */
export interface Tested<A, E = never> {
	/** Absent when the generator discarded the input. */
	readonly value: A | undefined
	readonly choices: Choices
	readonly bounds: ReadonlyArray<number>
	readonly spans: ReadonlyArray<Span>
	readonly size: number
	readonly verdict: Verdict<E>
	/** What the provided `Feedback` counted as new during this input, when it was executed with `observe`. */
	readonly novelty: number
	/** The score the property gave with `target`. */
	readonly score: number | undefined
	readonly durationMs: number
}

export interface Failure<A, E = never> {
	readonly signature: string
	/** The simplest input found that fails this way. */
	readonly value: A
	/** The input as first found, before shrinking. */
	readonly original: A
	readonly message: string
	readonly cause: Cause.Cause<E> | undefined
	/** Reruns exactly this input. Absent for a pinned example, which has no choices. */
	readonly replay: string | undefined
	readonly shrinkSteps: number
	readonly foundBy: "example" | "regression" | "replay" | "search" | "shrinking"
}

export interface Report<A, E = never> {
	readonly name: string
	readonly seed: number
	/** Inputs the property judged: generated ones, and pinned examples and replayed regressions. */
	readonly runs: number
	readonly discards: number
	/** Inputs a search kept because they did something new. */
	readonly kept: number
	readonly durationMs: number
	readonly failures: ReadonlyArray<Failure<A, E>>
	/** Why the run counts as failed although no input failed: nothing was judged. */
	readonly exhausted: string | undefined
	/** The time budget ended the search before it had judged the `runs` it was asked for. Not a failure by itself. */
	readonly budgetSpent: boolean
	readonly labels: Readonly<Record<string, number>>
	readonly feedback: FeedbackSummary | undefined
	readonly format: (value: A) => string
}

export const passed = (report: Report<any, any>): boolean => report.failures.length === 0 && report.exhausted === undefined

// The steps of a run, for searches

export interface ExecuteOptions {
	/** Choices to replay first; the rest are drawn fresh. Without it the whole input is fresh. */
	readonly prefix?: Choices | undefined
	readonly size?: number | undefined
	/** Read the `Feedback` after this input, into `Tested.novelty`. Default `false`: reading it can cost more than the input. */
	readonly observe?: boolean | undefined
}

/**
 * A run in progress. A search is a loop over these steps: `execute` inputs
 * while the run `wantsMore`, and `keep` the ones worth building on.
 */
export interface Run<A, E = never, R = never> {
	/** The run's own randomness, for the search's decisions. */
	readonly rng: Rng
	/** Whether the budget allows another input and fewer failures were found than asked for. */
	readonly wantsMore: Effect.Effect<boolean>
	/** Generates an input and runs the property on it. */
	readonly execute: (options?: ExecuteOptions) => Effect.Effect<Tested<A, E>, never, R>
	/** Runs an input again exactly, reading the `Feedback` after it. Counts as no run. */
	readonly observe: (tested: Tested<A, E>) => Effect.Effect<Tested<A, E>, never, R>
	/** `Feedback.peek`: whether anything new happened since the feedback was last read. */
	readonly peek: Effect.Effect<number>
	/** Records that the search kept an input, for the report. */
	readonly keep: (tested: Tested<A, E>) => void
}

// Options

/** A property may use a `Scope`: each input gets its own, closed before the next input. */
export type Property<A, E, R> = (value: A) => Effect.Effect<void | boolean, E, R> | boolean | void

export interface CheckOptions<A, E = never, R = never> {
	/** Identifies the property in reports and in the regression store. */
	readonly name?: string | undefined
	/** Generated inputs to judge. Default 100. Pinned examples and regressions come on top. */
	readonly runs?: number | undefined
	/**
	 * Stop searching after this long, whatever `runs` says. Shrinking what was
	 * found may take as long again, and then stops with the best input so far.
	 */
	readonly budget?: Duration.Input | undefined
	/** Default: from `Random`. */
	readonly seed?: number | undefined
	/** Keep searching until this many distinct failures are found. Default 1. */
	readonly failures?: number | undefined
	/** Discards allowed before the run gives up. Default ten per run. */
	readonly maxDiscards?: number | undefined
	/** Candidates the shrinker may run per failure. Default 2000. */
	readonly maxShrinks?: number | undefined
	/**
	 * A single input taking longer than this fails with the signature `Timeout`.
	 * An Effect that yields is interrupted at the limit. Code that never yields
	 * cannot be, and fails once it returns. Measured on the real clock for both.
	 */
	readonly timeout?: Duration.Input | undefined
	/** Values run before anything generated, whatever the generator has become. */
	readonly examples?: ReadonlyArray<A> | undefined
	/** A replay token from a report: run only that input. */
	readonly replay?: string | undefined
	/** How inputs are chosen. Default `Search.random`. */
	readonly search?: Search<A, E, R> | undefined
	/** How a value is printed in reports. */
	readonly format?: ((value: A) => string) | undefined
}

const environment = Config.all({
	runs: Config.option(Config.Int("PROP_RUNS")),
	scale: Config.option(Config.Finite("PROP_SCALE")),
	budgetMs: Config.option(Config.Finite("PROP_BUDGET_MS")),
	seed: Config.option(Config.Int("PROP_SEED")),
	failures: Config.option(Config.Int("PROP_FAILURES")),
	replay: Config.option(Config.String("PROP_REPLAY")),
})

/**
 * The options as the environment overrides them, so a run's budget, seed and
 * replay change without touching the test: `PROP_RUNS`, `PROP_SCALE` (multiplies
 * the runs, `PROP_RUNS` included), `PROP_BUDGET_MS`, `PROP_SEED`,
 * `PROP_FAILURES`, `PROP_REPLAY`. `check` itself reads only its arguments.
 */
export const fromEnvironment = <A, E, R>(options: CheckOptions<A, E, R>): Effect.Effect<CheckOptions<A, E, R>> =>
	Effect.map(Effect.orDie(environment), (env) => ({
		...options,
		runs: Math.max(1, Math.ceil((Option.getOrUndefined(env.runs) ?? options.runs ?? DEFAULT_RUNS) * Option.getOrElse(env.scale, () => 1))),
		budget: Option.getOrUndefined(env.budgetMs) ?? options.budget,
		seed: Option.getOrUndefined(env.seed) ?? options.seed,
		failures: Option.getOrUndefined(env.failures) ?? options.failures,
		replay: Option.getOrUndefined(env.replay) ?? options.replay,
	}))

const DEFAULT_RUNS = 100

// Describing a failure

/** The first frame of a stack that is the caller's own code: `file:line`. */
const thrownAt = (error: Error): string | undefined => {
	for (const line of (error.stack ?? "").split("\n").slice(1)) {
		const match = /\(?([^()\s]+):(\d+):\d+\)?$/.exec(line.trim())
		if (match === null) continue
		const file = match[1]!
		if (file.includes("node_modules") || file.startsWith("node:")) continue
		return `${relativePath(file)}:${match[2]}`
	}
	return undefined
}

const groupOf = (thrown: unknown): string => {
	if (typeof thrown === "object" && thrown !== null && "_tag" in thrown && typeof thrown._tag === "string") return thrown._tag
	if (thrown instanceof Error) {
		const at = thrownAt(thrown)
		return at === undefined ? thrown.name : `${thrown.name} at ${at}`
	}
	return Formatter.format(thrown).slice(0, 80)
}

const failed = <E>(cause: Cause.Cause<E>, named: string | undefined): Verdict<E> => {
	const reason = cause.reasons.find((r) => !Cause.isInterruptReason(r))
	const group = reason === undefined ? "Interrupted" : Cause.isFailReason(reason) ? `Fail(${groupOf(reason.error)})` : groupOf(reason.defect)
	return { _tag: "Fail", signature: named ?? group, message: Cause.pretty(cause), cause }
}

const discardOf = (cause: Cause.Cause<unknown>): Discard | undefined => {
	for (const reason of cause.reasons) {
		if (Cause.isDieReason(reason) && reason.defect instanceof Discard) return reason.defect
	}
	return undefined
}

// Checking

interface Found<A, E> {
	readonly tested: Tested<A, E> & { readonly value: A }
	readonly foundBy: Failure<A, E>["foundBy"]
	/** A pinned example is a value with no choices behind it. */
	readonly pinned: boolean
}

/**
 * Searches for inputs that fail `property`, and reports what it found. The
 * result is a report whether or not the property held: use `assert` to fail on it.
 */
export const check = <A, E = never, R = never>(
	gen: Gen.Gen<A>,
	property: Property<A, E, R>,
	options: CheckOptions<A, E, Exclude<R, Scope.Scope>> = {},
): Effect.Effect<Report<A, E>, never, Exclude<R, Scope.Scope>> =>
	checkScoped(gen, property as Property<A, E, Exclude<R, Scope.Scope> | Scope.Scope>, options)

const checkScoped = <A, E, R>(gen: Gen.Gen<A>, property: Property<A, E, R | Scope.Scope>, options: CheckOptions<A, E, R>): Effect.Effect<Report<A, E>, never, R> =>
	Effect.gen(function* () {
		const feedback = yield* Feedback
		yield* feedback.begin
		const regressions = yield* Regressions
		const name = options.name ?? "property"
		const format = options.format ?? ((value: A): string => Formatter.format(value))
		const seed = options.seed ?? Math.floor((yield* Random.next) * 0x1_0000_0000)
		if (!Number.isSafeInteger(seed)) return yield* Effect.die(new Error(`effect-prop: the seed must be an integer, got ${seed}`))
		const maxRuns = options.runs ?? DEFAULT_RUNS
		const wanted = options.failures ?? 1
		// NaN compares false with everything: the search would end before its first input, and pass.
		for (const [what, value] of [["runs", maxRuns], ["failures", wanted]] as const) {
			if (!Number.isSafeInteger(value) || value < 1) return yield* Effect.die(new Error(`effect-prop: ${what} must be a positive integer, got ${value}`))
		}
		const budgetMs = options.budget === undefined ? undefined : Duration.toMillis(options.budget)
		const timeoutMs = options.timeout === undefined ? undefined : Duration.toMillis(options.timeout)
		const maxDiscards = options.maxDiscards ?? maxRuns * 10
		const maxShrinks = options.maxShrinks ?? 2000
		const replay = options.replay

		// The real clock throughout: a budget or a slow input is about real time,
		// also in a test that controls the Effect clock.
		const started = performance.now()
		const rng = new Rng(seed)
		const found = new Map<string, Found<A, E>>()
		const labels: Record<string, number> = {}
		/** Generated inputs judged, which `runs` bounds; pinned and replayed ones are counted apart. */
		let searched = 0
		let pinned = 0
		let discards = 0
		let attempts = 0
		let kept = 0
		let budgetSpent = false

		/** Runs the property on one value, in its own scope. */
		const judge = Effect.fnUntraced(function* (value: A) {
			const state = new CaseState()
			const before = performance.now()
			const body = Effect.suspend(() => {
				const result = property(value)
				return Effect.isEffect(result) ? result : Effect.succeed(result)
			}).pipe(Effect.scoped, Effect.provideService(CurrentCase, state))
			const exit = yield* Effect.exit(options.timeout === undefined ? Effect.asSome(body) : Effect.timeoutOption(body, options.timeout))
			const durationMs = performance.now() - before
			let verdict: Verdict<E>
			if (Exit.isSuccess(exit)) {
				// Code that never yields outlasts the interrupt: judge it by the time it took.
				verdict = Option.isNone(exit.value) || (timeoutMs !== undefined && durationMs > timeoutMs)
					? { _tag: "Fail", signature: state.signature ?? "Timeout", message: `the property took ${Math.round(durationMs)} ms, over its timeout of ${timeoutMs} ms`, cause: undefined }
					: exit.value.value === false
						? { _tag: "Fail", signature: state.signature ?? "ReturnedFalse", message: "the property returned false", cause: undefined }
						: { _tag: "Pass" }
			} else {
				const discarded = discardOf(exit.cause)
				verdict = discarded === undefined ? failed(exit.cause, state.signature) : { _tag: "Discard", reason: discarded.reason }
			}
			return { verdict, state, durationMs }
		})

		/** Keeps one input per failure group: the simplest seen. */
		const record = (tested: Tested<A, E>, foundBy: Failure<A, E>["foundBy"], isExample = false): void => {
			if (tested.verdict._tag !== "Fail") return
			const known = found.get(tested.verdict.signature)
			if (known !== undefined && (isExample || known.pinned || compareChoices(known.tested.choices, tested.choices) <= 0)) return
			found.set(tested.verdict.signature, { tested: tested as Found<A, E>["tested"], foundBy: known?.foundBy ?? foundBy, pinned: isExample })
		}

		/** Builds the input the choices describe and judges it. Counts nothing. */
		const probe = Effect.fnUntraced(function* (source: Source, observe: boolean) {
			let generated: ReturnType<typeof Gen.generate<A>>
			try {
				generated = Gen.generate(gen, source)
			} catch (error) {
				// A generator that throws is a broken test: stop, and say how to get back here.
				const where = `seed ${seed}, PROP_REPLAY='${encodeReplay({ choices: source.choices, size: source.size })}'`
				return yield* Effect.die(new Error(`effect-prop: the generator of ${name} threw (${where})`, { cause: error }))
			}
			if (generated instanceof Discard) {
				const tested: Tested<A, E> = {
					value: undefined,
					choices: source.choices,
					bounds: source.bounds,
					spans: source.spans,
					size: source.size,
					verdict: { _tag: "Discard", reason: generated.reason },
					novelty: 0,
					score: undefined,
					durationMs: 0,
				}
				return { tested, labels: new Set<string>() }
			}
			const judged = yield* judge(generated.value)
			const tested: Tested<A, E> = {
				value: generated.value,
				choices: generated.choices,
				bounds: generated.bounds,
				spans: generated.spans,
				size: source.size,
				verdict: judged.verdict,
				novelty: observe ? yield* feedback.novelty : 0,
				score: judged.state.score,
				durationMs: judged.durationMs,
			}
			return { tested, labels: judged.state.labels }
		})

		const count = (tested: Tested<A, E>, caseLabels: ReadonlySet<string>, generated: boolean): void => {
			if (tested.verdict._tag === "Discard") {
				discards++
				return
			}
			if (generated) searched++
			else pinned++
			for (const each of caseLabels) labels[each] = (labels[each] ?? 0) + 1
		}

		/** A generated input: counts against `runs`, and takes the next size and the next stretch of the seed. */
		const execute = Effect.fnUntraced(function* (executeOptions?: ExecuteOptions) {
			const size = executeOptions?.size ?? sizeAt(attempts)
			attempts++
			const result = yield* probe(new Source({ prefix: executeOptions?.prefix, rng: rng.fork(), size }), executeOptions?.observe === true)
			count(result.tested, result.labels, true)
			record(result.tested, "search")
			return result.tested
		})

		/** A recorded input, exactly: leaves `runs` and the seed's sequence as they were. */
		const replayExactly = Effect.fnUntraced(function* (recorded: { readonly choices: Choices; readonly size: number }, foundBy: Failure<A, E>["foundBy"]) {
			const result = yield* probe(new Source({ prefix: recorded.choices, size: recorded.size }), false)
			count(result.tested, result.labels, false)
			record(result.tested, foundBy)
		})

		const run: Run<A, E, R> = {
			rng,
			wantsMore: Effect.sync(() => {
				if (searched >= maxRuns || found.size >= wanted || discards > maxDiscards) return false
				budgetSpent = budgetMs !== undefined && performance.now() - started >= budgetMs
				return !budgetSpent
			}),
			execute,
			observe: (tested) => Effect.map(probe(new Source({ prefix: tested.choices, size: tested.size }), true), (result) => result.tested),
			peek: feedback.peek,
			keep: () => {
				kept++
			},
		}

		const replayed = replay === undefined ? undefined : decodeReplay(replay)
		if (replay !== undefined && replayed === undefined) return yield* Effect.die(new Error(`effect-prop: not a replay token: ${replay}`))

		if (replayed !== undefined) {
			yield* replayExactly(replayed, "replay")
		} else {
			for (const value of options.examples ?? []) {
				const judged = yield* judge(value)
				const tested: Tested<A, E> = { value, choices: [], bounds: [], spans: [], size: 0, verdict: judged.verdict, novelty: 0, score: judged.state.score, durationMs: judged.durationMs }
				count(tested, judged.state.labels, false)
				record(tested, "example", true)
			}
			// Remembered under the property's name: an unnamed check has nothing to look up.
			for (const regression of options.name === undefined ? [] : yield* regressions.load(name)) yield* replayExactly(regression, "regression")
			// What the pinned inputs reached is reached, and is no generated input's doing.
			yield* feedback.novelty
			yield* (options.search ?? random)(run)
			// So the summary covers the inputs a search ran without observing each one.
			yield* feedback.novelty
		}

		// Shrink one input per failure group. A candidate that fails differently is a
		// failure of its own, and is shrunk in turn while more failures are wanted.
		const failures: Array<Failure<A, E>> = []
		const shrunk = new Set<string>()
		const shrinkingSince = performance.now()
		for (;;) {
			const next = [...found].find(([group]) => !shrunk.has(group))
			if (next === undefined) break
			const [group, { tested: original, foundBy, pinned: isPinned }] = next
			shrunk.add(group)
			const result = isPinned || replayed !== undefined
				? { best: original, steps: 0 }
				: yield* shrink(
						original,
						(choices) =>
							Effect.map(probe(new Source({ prefix: choices, size: original.size }), false), ({ tested }) => {
								if (tested.verdict._tag !== "Fail") return undefined
								if (tested.verdict.signature === group) return tested as Found<A, E>["tested"]
								if (found.size < wanted) record(tested, "shrinking")
								return undefined
							}),
						{ maxTries: maxShrinks, shouldStop: () => budgetMs !== undefined && performance.now() - shrinkingSince > budgetMs },
					).pipe(Effect.withSpan("effect-prop.shrink", { attributes: { "prop.signature": group } }))
			const verdict = result.best.verdict as Extract<Verdict<E>, { _tag: "Fail" }>
			const failure: Failure<A, E> = {
				signature: group,
				value: result.best.value,
				original: original.value,
				message: verdict.message,
				cause: verdict.cause,
				replay: isPinned ? undefined : encodeReplay(result.best),
				shrinkSteps: result.steps,
				foundBy,
			}
			failures.push(failure)
			if (!isPinned && options.name !== undefined) {
				// Bookkeeping must not cost the failure it is about.
				yield* regressions
					.save(name, { choices: result.best.choices, size: result.best.size, signature: group, value: format(failure.value) })
					.pipe(Effect.catchCause((cause) => Effect.logWarning(`effect-prop: could not remember the failure of ${name}`, cause)))
			}
		}

		const runs = searched + pinned
		const exhausted = failures.length > 0
			? undefined
			: runs === 0
				? `no input was judged: ${discards} discarded`
				: discards > maxDiscards
					? `gave up after ${discards} discards for ${runs} judged inputs`
					: undefined
		const report: Report<A, E> = {
			name,
			seed,
			runs,
			discards,
			kept,
			durationMs: performance.now() - started,
			failures,
			exhausted,
			budgetSpent,
			labels,
			feedback: yield* feedback.summary.pipe(Effect.catchCause((cause) => Effect.as(Effect.logWarning("effect-prop: no feedback summary", cause), undefined))),
			format,
		}
		yield* Effect.annotateCurrentSpan({ "prop.runs": runs, "prop.discards": discards, "prop.failures": failures.length, "prop.seed": seed })
		return report
	}).pipe(Effect.withSpan("effect-prop.check", { attributes: { "prop.name": options.name ?? "property" } }))

// Reporting

const indent = (text: string, by = "    "): string => text.split("\n").map((line) => `${by}${line}`).join("\n")

const MAX_FILES = 8
const MAX_UNREACHED = 8

/**
 * The report as text: every failure with its input, its error and the command
 * that replays it. With `coverage`, also each file's unreached functions.
 */
export const formatReport = <A, E>(report: Report<A, E>, options: { readonly coverage?: boolean | undefined } = {}): string => {
	const lines: Array<string> = []
	const counts = `${report.runs} runs${report.budgetSpent ? ", stopped by its time budget" : ""}, ${report.discards} discarded, seed ${report.seed}, ${Math.round(report.durationMs)} ms`
	if (passed(report)) lines.push(`${report.name}: passed (${counts})`)
	else if (report.exhausted !== undefined) lines.push(`${report.name}: ${report.exhausted} (${counts})`)
	else lines.push(`${report.name}: ${report.failures.length} distinct failure${report.failures.length === 1 ? "" : "s"} (${counts})`)
	report.failures.forEach((failure, index) => {
		lines.push("", `  ${index + 1}. ${failure.signature} (found by ${failure.foundBy}${failure.shrinkSteps > 0 ? `, shrunk in ${failure.shrinkSteps} steps` : ""})`)
		lines.push("    input:", indent(report.format(failure.value), "      "))
		lines.push(indent(failure.message))
		if (failure.replay !== undefined) lines.push(`    replay: PROP_REPLAY='${failure.replay}'`)
	})
	const labelled = Object.entries(report.labels).sort((a, b) => b[1] - a[1])
	if (labelled.length > 0) {
		lines.push("", "  inputs:")
		for (const [each, n] of labelled) lines.push(`    ${((100 * n) / Math.max(1, report.runs)).toFixed(1).padStart(5)}% ${each}`)
	}
	if (report.feedback !== undefined) {
		lines.push("", `  ${report.feedback.kind}: reached ${report.feedback.covered} of ${report.feedback.total} known, ${report.kept} inputs kept`)
		if (options.coverage === true) {
			// The files the inputs got into first: that is where a gap is a gap in the generator.
			const files = [...report.feedback.files].sort((a, b) => b.covered - a.covered)
			for (const file of files.slice(0, MAX_FILES)) {
				const more = file.unreached.length > MAX_UNREACHED ? ` and ${file.unreached.length - MAX_UNREACHED} more` : ""
				lines.push(`    ${file.file}: ${file.covered} of ${file.total}${file.unreached.length > 0 ? `; never reached: ${file.unreached.slice(0, MAX_UNREACHED).join(", ")}${more}` : ""}`)
			}
			if (files.length > MAX_FILES) lines.push(`    and ${files.length - MAX_FILES} more files`)
		}
	}
	return lines.join("\n")
}

/** A property did not hold. `message` is the formatted report. */
export class PropertyFailed extends Schema.TaggedError<PropertyFailed>()("effect-prop/PropertyFailed", {
	message: Schema.String,
}) {}

/** Fails with `PropertyFailed` unless the report passed. */
export const assert = <A, E>(report: Report<A, E>): Effect.Effect<Report<A, E>, PropertyFailed> =>
	passed(report) ? Effect.succeed(report) : Effect.fail(new PropertyFailed({ message: formatReport(report) }))

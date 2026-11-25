// Shrinking: find the simplest choices that still fail the same way.
//
// The shrinker never looks at the value. It edits the recorded choices (delete
// a span, replace a node with a descendant, lower a number), runs the generator
// and the property again, and keeps an edit when the same failure comes back on
// choices that are simpler (shorter, then smaller). The generator rebuilds a
// valid value from whatever choices it is given, so every candidate is a valid
// input and no generator needs a shrinker of its own.
import { Effect } from "effect"
import { type Choices, compareChoices, type Span } from "./Source"

/** A run's choices as the generator read them, with the spans it marked. */
export interface Candidate {
	readonly choices: Choices
	/** The largest value each choice could have been. */
	readonly bounds: ReadonlyArray<number>
	readonly spans: ReadonlyArray<Span>
}

/** Runs the given choices. Returns what the generator actually read when the failure reproduces. */
export type Probe<C extends Candidate, R> = (choices: Choices) => Effect.Effect<C | undefined, never, R>

export interface ShrinkResult<C extends Candidate> {
	readonly best: C
	/** Candidates accepted as simpler failures. */
	readonly steps: number
}

export interface ShrinkOptions {
	/** Candidates the shrinker may run. */
	readonly maxTries: number
	/** Asked before every candidate: `true` ends shrinking with the best input so far. */
	readonly shouldStop?: (() => boolean) | undefined
}

const without = (choices: Choices, start: number, end: number): Array<number> => [...choices.slice(0, start), ...choices.slice(end)]

const bySizeDescending = (spans: ReadonlyArray<Span>): Array<Span> =>
	[...spans].sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start)

/** How many same-label descendants of one span the shrinker tries as its replacement. */
const MAX_REPLACEMENTS = 8

/** Spans of each label, by where they start. */
const indexByLabel = (spans: ReadonlyArray<Span>): ReadonlyMap<string, ReadonlyArray<Span>> => {
	const byLabel = new Map<string, Array<Span>>()
	for (const span of spans) {
		const same = byLabel.get(span.label)
		if (same === undefined) byLabel.set(span.label, [span])
		else same.push(span)
	}
	for (const same of byLabel.values()) same.sort((a, b) => a.start - b.start || b.end - a.end)
	return byLabel
}

/**
 * Up to `MAX_REPLACEMENTS` spans of `outer`'s label that lie inside it and are
 * shorter. Found by binary search, so a pass over every span does not scan
 * every span for each one.
 */
const within = (byLabel: ReadonlyMap<string, ReadonlyArray<Span>>, outer: Span): Array<Span> => {
	const same = byLabel.get(outer.label) ?? []
	let low = 0
	let high = same.length
	while (low < high) {
		const middle = (low + high) >> 1
		if (same[middle]!.start < outer.start) low = middle + 1
		else high = middle
	}
	const found: Array<Span> = []
	for (let i = low; i < same.length && same[i]!.start < outer.end && found.length < MAX_REPLACEMENTS; i++) {
		const span = same[i]!
		// One of the same extent would replace the span with itself.
		if (span.end <= outer.end && span.end - span.start < outer.end - outer.start) found.push(span)
	}
	return found
}

export const shrink = <C extends Candidate, R>(initial: C, probe: Probe<C, R>, options: ShrinkOptions): Effect.Effect<ShrinkResult<C>, never, R> =>
	Effect.gen(function* () {
		let best = initial
		let tries = 0
		let steps = 0
		let stopped = false
		/** Whether the budget of tries or of time is spent. */
		const done = (): boolean => stopped || tries >= options.maxTries || (stopped = options.shouldStop?.() === true)
		const tried = new Set<string>([initial.choices.join(",")])

		const attempt = Effect.fnUntraced(function* (choices: Choices, mustShorten = false) {
			if (done() || compareChoices(choices, best.choices) >= 0) return false
			const key = choices.join(",")
			if (tried.has(key)) return false
			tried.add(key)
			tries++
			const result = yield* probe(choices)
			if (result === undefined || compareChoices(result.choices, best.choices) >= 0) return false
			// The generator draws 0 past the end of what it is given, so a deletion it did
			// not need comes back as the same length: not the step the caller was after.
			if (mustShorten && result.choices.length >= best.choices.length) return false
			best = result
			steps++
			return true
		})

		/** Removes whole spans, largest first: array elements, filter retries, labelled nodes. */
		const deleteSpans = Effect.fnUntraced(function* () {
			let spans = bySizeDescending(best.spans)
			for (let i = 0; i < spans.length && !done(); ) {
				const span = spans[i]!
				if (yield* attempt(without(best.choices, span.start, span.end))) spans = bySizeDescending(best.spans)
				else i++
			}
		})

		/** Replaces a span with a span of the same label inside it: a tree node with one of its subtrees. */
		const hoistSpans = Effect.fnUntraced(function* () {
			let spans = bySizeDescending(best.spans)
			let byLabel = indexByLabel(best.spans)
			for (let i = 0; i < spans.length && !done(); ) {
				const outer = spans[i]!
				let replaced = false
				for (const candidate of within(byLabel, outer)) {
					const choices = [...best.choices.slice(0, outer.start), ...best.choices.slice(candidate.start, candidate.end), ...best.choices.slice(outer.end)]
					if (yield* attempt(choices)) {
						replaced = true
						break
					}
				}
				if (replaced) {
					spans = bySizeDescending(best.spans)
					byLabel = indexByLabel(best.spans)
				} else i++
			}
		})

		/** Removes runs of choices no span covers, from the end, where an edit disturbs the least. */
		const deleteChunks = Effect.fnUntraced(function* () {
			for (const size of [8, 4, 2, 1]) {
				for (let start = best.choices.length - size; start >= 0 && !done(); start--) {
					if (start + size > best.choices.length) continue
					yield* attempt(without(best.choices, start, start + size))
				}
			}
		})

		/** Sets every choice of a span to 0, the simplest value of whatever it built. */
		const zeroSpans = Effect.fnUntraced(function* () {
			let spans = bySizeDescending(best.spans)
			for (let i = 0; i < spans.length && !done(); i++) {
				const span = spans[i]!
				if (span.end - span.start < 2) continue
				const choices = [...best.choices]
				for (let at = span.start; at < span.end; at++) choices[at] = 0
				if (yield* attempt(choices)) spans = bySizeDescending(best.spans)
			}
		})

		/** Lowers each choice: to 0 if that still fails, otherwise by binary search. */
		const lowerChoices = Effect.fnUntraced(function* () {
			for (let i = 0; i < best.choices.length && !done(); i++) {
				const value = best.choices[i]!
				if (value === 0) continue
				const replace = (v: number): Array<number> => {
					const choices = [...best.choices]
					choices[i] = v
					return choices
				}
				if (yield* attempt(replace(0))) continue
				let low = 0
				while (i < best.choices.length && low + 1 < best.choices[i]! && !done()) {
					const high: number = best.choices[i]!
					const middle = low + Math.floor((high - low) / 2)
					if (!(yield* attempt(replace(middle)))) low = middle
				}
			}
		})

		/**
		 * Lowers a choice by one and removes a span after it: a length drawn first,
		 * then that many elements, shrinks only when both change together.
		 */
		const lowerAndDelete = Effect.fnUntraced(function* () {
			for (let i = 0; i < best.choices.length && !done(); i++) {
				if (best.choices[i] === 0) continue
				const after = best.spans.filter((s) => s.start > i).sort((a, b) => a.start - b.start)
				// The nearest and the farthest: enough to find one that goes, without trying every pair.
				const candidates = after.length <= 2 * MAX_REPLACEMENTS ? after : [...after.slice(0, MAX_REPLACEMENTS), ...after.slice(-MAX_REPLACEMENTS)]
				for (const span of candidates) {
					if (best.choices[i] === 0 || i >= span.start || span.end > best.choices.length) break
					const choices = without(best.choices, span.start, span.end)
					choices[i] = best.choices[i]! - 1
					yield* attempt(choices, true)
				}
			}
		})

		/**
		 * Moves a choice's amount onto one that follows it. When a total is what fails,
		 * no single number can go down; this empties one so the next round can delete it.
		 */
		const redistribute = Effect.fnUntraced(function* () {
			for (let i = 0; i < best.choices.length && !done(); i++) {
				for (let j = i + 1; j < Math.min(best.choices.length, i + 1 + MAX_REPLACEMENTS); j++) {
					const amount = best.choices[i]!
					if (amount === 0) break
					for (const moved of amount > 1 ? [amount, Math.ceil(amount / 2)] : [amount]) {
						if (best.choices[j]! + moved > (best.bounds[j] ?? 0)) continue
						const choices = [...best.choices]
						choices[i] = amount - moved
						choices[j] = best.choices[j]! + moved
						if (yield* attempt(choices)) break
					}
				}
			}
		})

		/** Swaps a choice with a larger one before it, so equal-shaped neighbours end up in order. */
		const sortNeighbours = Effect.fnUntraced(function* () {
			for (let i = 0; i + 1 < best.choices.length && !done(); i++) {
				if (best.choices[i]! <= best.choices[i + 1]!) continue
				const choices = [...best.choices]
				choices[i] = best.choices[i + 1]!
				choices[i + 1] = best.choices[i]!
				yield* attempt(choices)
			}
		})

		for (;;) {
			const before = steps
			yield* deleteSpans()
			yield* hoistSpans()
			yield* zeroSpans()
			yield* deleteChunks()
			yield* lowerAndDelete()
			yield* lowerChoices()
			yield* redistribute()
			yield* sortNeighbours()
			if (steps === before || done()) break
		}
		return { best, steps }
	})

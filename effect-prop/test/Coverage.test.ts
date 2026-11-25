import { Effect, Layer, Logger } from "effect"
import { describe, expect, it } from "vitest"
import { Feedback, Gen, Prop, Search, Spans } from "../src/index"
import { Coverage } from "../src/node"
import { parse } from "./fixtures/needle"

const needle = Coverage.layer({ include: (url) => url.includes("fixtures/needle") })
// 16 letters, six of them in order: one in 16 million for a random string.
const input = Gen.string({ char: Gen.charOf("abcdefghijklmnot"), maxLength: 8 })
const property = (s: string): void => {
	parse(s)
}

describe("Coverage", () => {
	it("tracks branches V8 stops reporting once their count matches the parent's", () => {
		const tracker = new Coverage.Tracker(() => true)
		const slice = (blocks: ReadonlyArray<readonly [number, number, number]>, count = 1) => [
			{ scriptId: "1", url: "file:///a.js", functions: [{ functionName: "f", ranges: [{ startOffset: 0, endOffset: 100, count }, ...blocks.map(([startOffset, endOffset, c]) => ({ startOffset, endOffset, count: c }))] }] },
		]
		// First call: the function, and the branch 10..50 not taken (its inner branch is not reported at all).
		expect(tracker.absorb(slice([[10, 50, 0]]))).toBe(1)
		// Same path again: nothing new.
		expect(tracker.absorb(slice([[10, 50, 0]]))).toBe(0)
		// The outer branch taken (so not reported), the inner one now reported as not taken.
		expect(tracker.absorb(slice([[20, 40, 0]]))).toBe(1)
		// Outer not taken again: the inner one, inside it, must not count as taken.
		expect(tracker.absorb(slice([[10, 50, 0]]))).toBe(0)
		// Both taken.
		expect(tracker.absorb(slice([]))).toBe(1)
		expect(tracker.totals()).toEqual({ covered: 3, total: 3 })
		// A function that was listed but not called is known and not reached.
		expect(tracker.absorb(slice([], 0))).toBe(0)
	})

	it("peeks without marking, and forgives at the next peek what nothing reproduced", () => {
		const tracker = new Coverage.Tracker(() => true)
		const called = [{ scriptId: "1", url: "file:///a.js", functions: [{ functionName: "f", ranges: [{ startOffset: 0, endOffset: 9, count: 1 }] }] }]
		expect(tracker.absorb(called, false)).toBe(1)
		expect(tracker.totals().covered).toBe(0)
		// Found again by a committed read: it is that input's.
		expect(tracker.absorb(called)).toBe(1)
		expect(tracker.absorb(called, false)).toBe(0)

		const phantom = [{ scriptId: "2", url: "file:///b.js", functions: [{ functionName: "g", ranges: [{ startOffset: 0, endOffset: 9, count: 1 }] }] }]
		expect(tracker.absorb(phantom, false)).toBe(1)
		// No committed read reproduced it: the next peek stops counting it.
		expect(tracker.absorb(phantom, false)).toBe(0)
		expect(tracker.totals().covered).toBe(2)
	})

	it("forgets what was reached when a check begins, and keeps what is known to exist", () => {
		const tracker = new Coverage.Tracker(() => true)
		const called = [{ scriptId: "1", url: "file:///a.js", functions: [{ functionName: "f", ranges: [{ startOffset: 0, endOffset: 9, count: 1 }, { startOffset: 2, endOffset: 5, count: 0 }] }] }]
		expect(tracker.absorb(called)).toBe(1)
		expect(tracker.absorb(called)).toBe(0)
		tracker.reset()
		expect(tracker.totals()).toEqual({ covered: 0, total: 2 })
		expect(tracker.absorb(called)).toBe(1)
	})

	// Before the search below makes the fixture hot: V8 stops counting calls of code it has optimized.
	it("reports no novelty for an input that takes a path already seen", async () => {
		const novelty: Array<number> = []
		await Effect.runPromise(
			Prop.check(Gen.constant("zzzz"), property, {
				runs: 5,
				search: (run) => Effect.gen(function* () {
					while (yield* run.wantsMore) novelty.push((yield* run.execute({ observe: true })).novelty)
				}),
			}).pipe(Effect.provide(needle)),
		)
		expect(novelty[0]).toBeGreaterThan(0)
		expect(novelty.slice(1)).toEqual([0, 0, 0, 0])
	})

	it("finds a bug behind nested branches that random search does not", async () => {
		const guided = await Effect.runPromise(
			Prop.check(input, property, { runs: 30_000, seed: 1, search: Search.coverage }).pipe(Effect.provide(needle)),
		)
		expect(guided.failures.map((f) => f.value)).toEqual(["effect"])
		expect(guided.kept).toBeGreaterThanOrEqual(6)
		expect(guided.feedback?.kind).toBe("v8 coverage")
		const file = guided.feedback!.files.find((f) => f.file.endsWith("fixtures/needle.ts"))!
		// The export getters vitest's transform adds are not the fixture's code.
		expect(file.unreached).toEqual(["neverCalled:24"])
		expect(file.covered).toBeLessThan(file.total)

		const blind = await Effect.runPromise(Prop.check(input, property, { runs: 30_000, seed: 1 }))
		expect(Prop.passed(blind)).toBe(true)
		expect(guided.runs).toBeLessThan(25_000)
	})

})

describe("Coverage.start", () => {
	it("is the same collection however often it is started, and warns a guided search that has no feedback", async () => {
		await Effect.runPromise(Effect.andThen(Coverage.start, Coverage.start))
		const warnings: Array<string> = []
		const logger = Logger.layer([Logger.make<unknown, void>(({ message }) => void warnings.push(String(message)))])
		const report = await Effect.runPromise(Prop.check(Gen.int(), () => true, { runs: 10, search: Search.coverage }).pipe(Effect.provide(logger)))
		expect(report.runs).toBe(10)
		expect(warnings.join()).toContain("Search.coverage has no Feedback to read")
	})
})

describe("Search.coverage", () => {
	/** Feedback that calls a value new the first time it is judged, and can invent novelty no input reproduces. */
	const fake = (judged: Array<number>, phantomEvery = 0) => {
		const seen = new Set<number>()
		let peeks = 0
		const read = (commit: boolean) =>
			Effect.sync(() => {
				const fresh = new Set(judged.filter((value) => !seen.has(value)))
				judged.length = 0
				if (commit) for (const value of fresh) seen.add(value)
				const phantom = !commit && phantomEvery > 0 && ++peeks % phantomEvery === 0 ? 1 : 0
				return fresh.size + phantom
			})
		return Layer.succeed(Feedback.Feedback, { begin: Effect.void, novelty: read(true), peek: read(false), summary: Effect.succeed(undefined) })
	}

	it("keeps exactly the inputs that did something new, reading the feedback far less often than once per input", async () => {
		const judged: Array<number> = []
		const kept: Array<number> = []
		let reads = 0
		const counting = Layer.effect(
			Feedback.Feedback,
			Effect.map(Feedback.Feedback, (inner) => ({
				begin: inner.begin,
				novelty: Effect.suspend(() => (reads++, inner.novelty)),
				peek: Effect.suspend(() => (reads++, inner.peek)),
				summary: inner.summary,
			})),
		).pipe(Layer.provide(fake(judged)))
		const report = await Effect.runPromise(
			Prop.check(Gen.int(0, 20), (n) => { judged.push(n) }, {
				runs: 4000,
				seed: 1,
				search: (run) => Search.coverage({ ...run, keep: (tested) => { kept.push(tested.value as number); run.keep(tested) } }),
			}).pipe(Effect.provide(counting)),
		)
		expect([...kept].sort((a, b) => a - b)).toEqual(Array.from({ length: 21 }, (_, i) => i))
		expect(report.kept).toBe(21)
		expect(report.runs).toBe(4000)
		expect(reads).toBeLessThan(1000)
	})

	it("is not slowed for good by novelty that no input reproduces", async () => {
		const judged: Array<number> = []
		let reads = 0
		const noisy = Layer.effect(
			Feedback.Feedback,
			Effect.map(Feedback.Feedback, (inner) => ({
				begin: inner.begin,
				novelty: Effect.suspend(() => (reads++, inner.novelty)),
				peek: Effect.suspend(() => (reads++, inner.peek)),
				summary: inner.summary,
			})),
		).pipe(Layer.provide(fake(judged, 3)))
		await Effect.runPromise(Prop.check(Gen.int(0, 5), (n) => { judged.push(n) }, { runs: 4000, seed: 1, search: Search.coverage }).pipe(Effect.provide(noisy)))
		// A phantom makes one batch run again input by input; it must not make every batch do so.
		expect(reads).toBeLessThan(4000)
	})
})

describe("Spans", () => {
	it("counts a parent > child pair of span names once", async () => {
		const novelty: Array<number> = []
		const traced = (n: number) =>
			Effect.void.pipe(Effect.withSpan(n % 2 === 0 ? "even" : "odd"), Effect.withSpan("classify"))
		const report = await Effect.runPromise(
			Prop.check(Gen.int(0, 9), traced, {
				runs: 40,
				seed: 1,
				search: (run) => Effect.gen(function* () {
					while (yield* run.wantsMore) novelty.push((yield* run.execute({ observe: true })).novelty)
				}),
			}).pipe(Effect.provide(Spans.layer)),
		)
		expect(novelty.reduce((a, b) => a + b, 0)).toBe(3)
		expect(novelty.filter((n) => n > 0).length).toBe(2)
		expect(report.feedback).toEqual({ kind: "span edges", covered: 3, total: 3, files: [] })
	})

	it("starts each check from nothing when two share the layer", async () => {
		const first: Array<number> = []
		const traced = () => Effect.void.pipe(Effect.withSpan("work"))
		const search = (into: Array<number>) => (run: Prop.Run<number>) =>
			Effect.gen(function* () {
				while (yield* run.wantsMore) into.push((yield* run.execute({ observe: true })).novelty)
			})
		const second: Array<number> = []
		await Effect.runPromise(
			Effect.gen(function* () {
				yield* Prop.check(Gen.int(), traced, { runs: 3, search: search(first) })
				yield* Prop.check(Gen.int(), traced, { runs: 3, search: search(second) })
			}).pipe(Effect.provide(Spans.layer)),
		)
		expect(first).toEqual([1, 0, 0])
		expect(second).toEqual([1, 0, 0])
	})
})

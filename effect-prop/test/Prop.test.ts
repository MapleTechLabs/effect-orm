import { Cause, ConfigProvider, Context, Data, Effect, Ref } from "effect"
import { describe, expect, it } from "vitest"
import { Gen, Prop, Regressions, Search, Source } from "../src/index"

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

const check = Prop.check

describe("check", () => {
	it("passes a property that holds, and counts its runs", async () => {
		const report = await run(check(Gen.array(Gen.int()), (xs) => [...xs].reverse().reverse().join() === xs.join(), { runs: 200, seed: 1 }))
		expect(Prop.passed(report)).toBe(true)
		expect(report.runs).toBe(200)
		expect(report.failures).toEqual([])
	})

	it("shrinks a failing list to the smallest one", async () => {
		// Fails for any list holding a number of at least 1000.
		const report = await run(check(Gen.array(Gen.int()), (xs) => xs.every((x) => x < 1000), { runs: 500, seed: 1 }))
		expect(report.failures).toHaveLength(1)
		expect(report.failures[0]!.value).toEqual([1000])
		expect(report.failures[0]!.signature).toBe("ReturnedFalse")
	})

	it("shrinks through dependent generators", async () => {
		const pair = Gen.gen(function* () {
			const length = yield* Gen.int(0, 30)
			const items = yield* Gen.array(Gen.int(0, 100), { minLength: length, maxLength: length })
			return { length, items }
		})
		const report = await run(check(pair, ({ items }) => items.reduce((a, b) => a + b, 0) < 150, { runs: 500, seed: 3 }))
		const { value } = report.failures[0]!
		expect(value.items.length).toBe(value.length)
		expect(value.items.reduce((a, b) => a + b, 0)).toBe(150)
		expect(value.length).toBe(2)
	})

	it("shrinks a recursive value by replacing a node with its subtree", async () => {
		type Expr = { readonly k: "lit"; readonly v: number } | { readonly k: "add" | "div"; readonly l: Expr; readonly r: Expr }
		const expr: Gen.Gen<Expr> = Gen.recursive<Expr>(
			Gen.map(Gen.int(0, 9), (v) => ({ k: "lit", v }) as const),
			(self) => Gen.struct({ k: Gen.element("add", "div"), l: self, r: self }),
			{ maxDepth: 6 },
		)
		const evaluate = (e: Expr): number => {
			if (e.k === "lit") return e.v
			if (e.k === "add") return evaluate(e.l) + evaluate(e.r)
			const divisor = evaluate(e.r)
			if (divisor === 0) throw new Error("division by zero")
			return Math.trunc(evaluate(e.l) / divisor)
		}
		const report = await run(check(expr, (e) => Number.isFinite(evaluate(e)), { runs: 2000, seed: 5 }))
		expect(report.failures[0]!.value).toEqual({ k: "div", l: { k: "lit", v: 0 }, r: { k: "lit", v: 0 } })
	})

	it("reports each distinct failure once when asked for several, each with its own replay", async () => {
		class TooBig extends Data.TaggedError("TooBig")<{ readonly n: number }> {}
		class Negative extends Data.TaggedError("Negative")<{ readonly n: number }> {}
		const property = (n: number) =>
			Effect.gen(function* () {
				if (n > 500) return yield* new TooBig({ n })
				if (n < -500) return yield* new Negative({ n })
				if (n === 13) throw new Error("unlucky")
			})
		const report = await run(check(Gen.int(-1000, 1000), property, { runs: 5000, failures: 3, seed: 2 }))
		expect(report.failures.map((f) => f.signature).sort()).toEqual([expect.stringMatching(/^Error at .*Prop\.test\.ts:\d+$/), "Fail(Negative)", "Fail(TooBig)"])
		const byGroup = Object.fromEntries(report.failures.map((f) => [f.signature.replace(/ at .*/, ""), f.value]))
		expect(byGroup).toEqual({ "Fail(TooBig)": 501, "Fail(Negative)": -501, Error: 13 })
		for (const failure of report.failures) {
			const again = await run(check(Gen.int(-1000, 1000), property, { replay: failure.replay }))
			expect(again.failures.map((f) => [f.signature, f.value, f.foundBy])).toEqual([[failure.signature, failure.value, "replay"]])
		}
	})

	it("groups by Prop.signature when the property names the failure", async () => {
		const report = await run(
			check(
				Gen.int(0, 100),
				(n) => Effect.gen(function* () {
					yield* Prop.signature(n % 2 === 0 ? "even" : "odd")
					return n < 50
				}),
				{ runs: 2000, failures: 2, seed: 1 },
			),
		)
		expect(Object.fromEntries(report.failures.map((f) => [f.signature, f.value]))).toEqual({ even: 50, odd: 51 })
	})

	it("gives each input its own scope, released before the next input", async () => {
		const report = await run(
			Effect.gen(function* () {
				const open = yield* Ref.make(0)
				const worst = yield* Ref.make(0)
				const result = yield* check(
					Gen.int(),
					() => Effect.gen(function* () {
						yield* Effect.acquireRelease(Ref.updateAndGet(open, (n) => n + 1), () => Ref.update(open, (n) => n - 1))
						yield* Ref.update(worst, (w) => Math.max(w, 1))
						const now = yield* Ref.get(open)
						return now === 1
					}),
					{ runs: 100 },
				)
				return { result, open: yield* Ref.get(open) }
			}),
		)
		expect(Prop.passed(report.result)).toBe(true)
		expect(report.open).toBe(0)
	})

	it("requires the services a property needs", async () => {
		class Limit extends Context.Service<Limit, { readonly max: number }>()("test/Limit") {}
		const property = (n: number) =>
			Effect.gen(function* () {
				return n <= (yield* Limit).max
			})
		const report = await run(Prop.check(Gen.int(0, 100), property, { runs: 1000, seed: 1 }).pipe(Effect.provideService(Limit, { max: 60 })))
		expect(report.failures.map((f) => f.value)).toEqual([61])
	})

	it("counts labels and discards, and fails when nothing was judged", async () => {
		const report = await run(
			check(
				Gen.int(0, 9),
				(n) => Effect.gen(function* () {
					yield* Prop.assume(n !== 0)
					yield* Prop.classify(n < 5, "small")
					yield* Prop.label(n % 2 === 0 ? "even" : "odd")
				}),
				{ runs: 300, seed: 1 },
			),
		)
		expect(Prop.passed(report)).toBe(true)
		expect(report.discards).toBeGreaterThan(5)
		expect(report.labels.even! + report.labels.odd!).toBe(300)
		expect(report.labels.small).toBeGreaterThan(50)

		const nothing = await run(check(Gen.int(), () => Prop.assume(false), { runs: 20 }))
		expect(Prop.passed(nothing)).toBe(false)
		expect(nothing.exhausted).toMatch(/no input was judged/)
		const filtered = await run(check(Gen.int().pipe(Gen.filter(() => false)), () => true, { runs: 20 }))
		expect(filtered.exhausted).toMatch(/no input was judged/)
		await expect(run(Effect.flatMap(Effect.succeed(nothing), Prop.assert))).rejects.toThrow(/no input was judged/)
	})

	it("fails an input that outlasts the timeout", async () => {
		const report = await run(check(Gen.int(0, 10), (n) => (n === 7 ? Effect.never : Effect.void), { runs: 500, timeout: "20 millis", seed: 1 }))
		expect(report.failures.map((f) => [f.signature, f.value])).toEqual([["Timeout", 7]])
	})

	it("runs pinned examples first, whatever the generator produces", async () => {
		const report = await run(check(Gen.int(0, 10), (n) => n !== 99, { examples: [99], runs: 50 }))
		expect(report.failures.map((f) => [f.value, f.foundBy, f.replay])).toEqual([[99, "example", undefined]])
		expect(report.runs).toBe(1)
	})

	it("judges its generated inputs on top of the pinned ones, which do not change what the seed generates", async () => {
		const judged = async (options: Prop.CheckOptions<number>) => {
			const seen: Array<number> = []
			const report = await run(check(Gen.int(), (n) => { seen.push(n) }, { runs: 5, seed: 7, ...options }))
			return { seen, runs: report.runs }
		}
		const plain = await judged({})
		const pinned = await judged({ examples: [1, 2, 3, 4, 5, 6, 7] })
		expect(plain.runs).toBe(5)
		expect(pinned.runs).toBe(12)
		expect(pinned.seen.slice(7)).toEqual(plain.seen)

		// A regression that now passes, remembered from an earlier run.
		await run(
			Effect.gen(function* () {
				const store = yield* Regressions.Regressions
				yield* store.save("seeded", { choices: [4], size: 9, signature: "old", value: "4" })
				const seen: Array<number> = []
				yield* check(Gen.int(), (n) => { seen.push(n) }, { name: "seeded", runs: 5, seed: 7 })
				expect(seen.slice(1)).toEqual(plain.seen)
			}).pipe(Effect.provide(Regressions.layerMemory)),
		)
	})

	it("fails a property that hangs without yielding, once it returns", async () => {
		const spin = (ms: number): void => {
			const until = performance.now() + ms
			while (performance.now() < until) {
				// busy
			}
		}
		const report = await run(check(Gen.int(0, 3), (n) => { if (n === 2) spin(40) }, { runs: 200, timeout: "15 millis", seed: 1 }))
		expect(report.failures.map((f) => [f.signature, f.value])).toEqual([["Timeout", 2]])
		expect(report.failures[0]!.message).toMatch(/took \d+ ms, over its timeout of 15 ms/)
	})

	it("stops shrinking when the budget is spent again, with the best input so far", async () => {
		const started = performance.now()
		// Every candidate that still fails costs 20 ms: unbounded, 2000 of them would take 40 s.
		const report = await run(check(Gen.array(Gen.int(), { minLength: 30 }), () => Effect.as(Effect.sleep("20 millis"), false), { runs: 1000, budget: "150 millis", seed: 1 }))
		expect(report.failures).toHaveLength(1)
		expect(performance.now() - started).toBeLessThan(2000)
	})

	it("counts an input once under a label, however often the property names it", async () => {
		const report = await run(
			check(Gen.int(), () => Effect.gen(function* () {
				yield* Prop.label("x")
				yield* Prop.label("x")
			}), { runs: 40 }),
		)
		expect(report.labels).toEqual({ x: 40 })
		expect(Prop.formatReport(report)).toContain("100.0% x")
	})

	it("stops on a generator that throws, saying how to get back to it", async () => {
		const broken = Gen.flatMap(Gen.array(Gen.int(0, 3)), (xs) => Gen.elements(xs))
		const failure = await run(Effect.flip(Effect.sandbox(check(broken, () => true, { name: "broken", seed: 11 }))))
		const message = String(Cause.squash(failure))
		expect(message).toMatch(/the generator of broken threw \(seed 11, PROP_REPLAY='p1\.[0-9a-z.]+'\)/)
		const token = /PROP_REPLAY='([^']+)'/.exec(message)![1]!
		const again = await run(Effect.flip(Effect.sandbox(check(broken, () => true, { name: "broken", replay: token }))))
		expect(String(Cause.squash(again))).toContain(`PROP_REPLAY='${token}'`)
	})

	it("remembers a failure and replays it before any new input", async () => {
		const gen = Gen.array(Gen.int(0, 100))
		const judged: Array<ReadonlyArray<number>> = []
		const property = (xs: ReadonlyArray<number>): boolean => {
			judged.push(xs)
			return !xs.includes(42)
		}
		await run(
			Effect.gen(function* () {
				const first = yield* check(gen, property, { name: "no 42", runs: 3000, seed: 1 })
				expect(first.failures.map((f) => [f.value, f.foundBy])).toEqual([[[42], "search"]])
				judged.length = 0
				const second = yield* check(gen, property, { name: "no 42", runs: 3000, seed: 99 })
				expect(judged[0]).toEqual([42])
				expect(second.failures.map((f) => [f.value, f.foundBy])).toEqual([[[42], "regression"]])
				expect(second.runs).toBe(1)
				const other = yield* check(gen, () => true, { name: "another property", runs: 5 })
				expect(Prop.passed(other)).toBe(true)
			}).pipe(Effect.provide(Regressions.layerMemory)),
		)
	})

	it("takes its budget from the environment over the options, through fromEnvironment only", async () => {
		const withEnv = <A, E>(options: Prop.CheckOptions<A, E>, values: Record<string, string>) =>
			run(Prop.fromEnvironment(options).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values)))))
		expect(await withEnv({ runs: 10 }, { PROP_SCALE: "3" })).toMatchObject({ runs: 30 })
		expect(await withEnv({ runs: 10, seed: 1 }, { PROP_RUNS: "7", PROP_SEED: "5" })).toMatchObject({ runs: 7, seed: 5 })
		expect(await withEnv({ runs: 10 }, { PROP_RUNS: "12", PROP_SCALE: "2.5" })).toMatchObject({ runs: 30 })
		expect(await withEnv({ failures: 1, budget: "1 second" }, { PROP_FAILURES: "4", PROP_BUDGET_MS: "250", PROP_REPLAY: "p1.1" })).toMatchObject({ failures: 4, budget: 250, replay: "p1.1" })
		expect(await withEnv({ runs: 10, seed: 3 }, {})).toMatchObject({ runs: 10, seed: 3, replay: undefined })
		await expect(withEnv({}, { PROP_RUNS: "many" })).rejects.toThrow()

		const many = await run(check(Gen.int(0, 3), (n) => Prop.signature(String(n)).pipe(Effect.as(false)), { runs: 500, failures: 4 }))
		expect(many.failures).toHaveLength(4)
		await expect(run(check(Gen.int(), () => true, { replay: "nonsense" }))).rejects.toThrow(/not a replay token/)
		await expect(run(check(Gen.int(), () => true, { seed: Number.NaN }))).rejects.toThrow(/seed must be an integer/)
		await expect(run(check(Gen.int(), () => false, { failures: Number.NaN }))).rejects.toThrow(/failures must be a positive integer/)
		await expect(run(check(Gen.int(), () => false, { runs: 0 }))).rejects.toThrow(/runs must be a positive integer/)
	})

	it("stops at its time budget", async () => {
		const report = await run(check(Gen.int(), () => Effect.sleep("2 millis"), { runs: 1_000_000, budget: "60 millis" }))
		expect(Prop.passed(report)).toBe(true)
		expect(report.runs).toBeGreaterThan(3)
		expect(report.runs).toBeLessThan(200)
		expect(report.budgetSpent).toBe(true)
		expect(Prop.formatReport(report)).toContain("stopped by its time budget")
		// Judging every input it was asked for is not being stopped, however long it took.
		let calls = 0
		const whole = await run(check(Gen.int(), () => (++calls === 2 ? Effect.sleep("80 millis") : Effect.void), { runs: 2, budget: "40 millis" }))
		expect([whole.runs, whole.budgetSpent]).toEqual([2, false])
		expect(whole.durationMs).toBeGreaterThan(40)
	})

	it("is deterministic in its seed", async () => {
		const once = () => run(check(Gen.array(Gen.string()), (xs) => xs.join("").length < 40, { runs: 400, seed: 11 }))
		const [a, b] = [await once(), await once()]
		expect(a.failures[0]!.replay).toBe(b.failures[0]!.replay)
		expect(a.failures[0]!.original).toEqual(b.failures[0]!.original)
	})

	it("formats a report a person can act on", async () => {
		const report = await run(check(Gen.array(Gen.int()), (xs) => xs.length < 3, { name: "short lists", runs: 300, seed: 1 }))
		const text = Prop.formatReport(report)
		expect(text).toMatch(/^short lists: 1 distinct failure \(\d+ runs, 0 discarded, seed 1, \d+ ms\)/)
		expect(text).toContain("[0,0,0]")
		expect(text).toContain(`replay: PROP_REPLAY='${report.failures[0]!.replay}'`)
		expect(Source.decodeReplay(report.failures[0]!.replay!)).toBeDefined()
	})
})

describe("searches", () => {
	it("target climbs a score of its own, given as a function of the input", async () => {
		const kept: Array<number> = []
		await run(
			check(Gen.array(Gen.boolean, { maxLength: 40 }), () => true, {
				runs: 300,
				seed: 1,
				search: (r) => Search.target<ReadonlyArray<boolean>>((tested) => tested.value?.length)({ ...r, keep: (tested) => { kept.push(tested.value!.length) } }),
			}),
		)
		// Each kept input scored higher than every one before it, up to the longest there is.
		expect(kept).toEqual([...kept].sort((a, b) => a - b))
		expect(new Set(kept).size).toBe(kept.length)
		expect(kept.at(-1)).toBe(40)
	})

	it("slow keeps an input only when it took longer than every one before it", async () => {
		const durations: Array<number> = []
		const report = await run(
			check(Gen.int(), () => Effect.void, { runs: 200, seed: 1, search: (r) => Search.slow({ ...r, keep: (tested) => { durations.push(tested.durationMs) } }) }),
		)
		// Time is noisy, so nothing is asserted about which inputs: only that the climb is one.
		expect(report.runs).toBe(200)
		expect(durations.length).toBeGreaterThan(0)
		expect(durations).toEqual([...durations].sort((a, b) => a - b))
	})

	it("target passes over a score that is not a number", async () => {
		const report = await run(
			check(Gen.int(0, 1000), (n) => Prop.target(n === 0 ? Number.NaN : n).pipe(Effect.as(n < 990)), { runs: 5000, seed: 3, search: Search.target() }),
		)
		expect(report.failures.map((f) => f.value)).toEqual([990])
	})

	it("target climbs to an input random search does not reach", async () => {
		// A needle: the property fails only at one exact 6-digit code, and scores how many leading digits match.
		const secret = [7, 3, 9, 1, 4, 8]
		const gen = Gen.array(Gen.int(0, 9), { minLength: 6, maxLength: 6 })
		const property = (guess: ReadonlyArray<number>) =>
			Effect.gen(function* () {
				const matched = secret.findIndex((digit, i) => guess[i] !== digit)
				yield* Prop.target(matched === -1 ? secret.length : matched)
				return matched !== -1
			})
		const climbed = await run(check(gen, property, { runs: 20_000, seed: 1, search: Search.target() }))
		expect(climbed.failures.map((f) => f.value)).toEqual([secret])
		const blind = await run(check(gen, property, { runs: 20_000, seed: 1 }))
		expect(Prop.passed(blind)).toBe(true)
		expect(climbed.runs).toBeLessThan(5000)
	})

	it("mutate keeps choices valid for the bounds it was given", () => {
		const rng = new Source.Rng(4)
		const parent = { choices: [1, 0, 5, 200, 3], bounds: [1, 1, 9, 255, 3] }
		const seen = new Set<string>()
		for (let i = 0; i < 2000; i++) {
			const child = Search.mutate(rng, parent, parent)
			expect(child.every((c) => Number.isSafeInteger(c) && c >= 0)).toBe(true)
			seen.add(child.join())
		}
		expect(seen.size).toBeGreaterThan(200)
	})

	it("a search is a loop over the run's steps", async () => {
		const sizes: Array<number> = []
		const report = await run(
			check(Gen.array(Gen.int()), (xs) => xs.length < 1000, {
				runs: 30,
				search: (r) => Effect.gen(function* () {
					while (yield* r.wantsMore) sizes.push((yield* r.execute({ size: 100 })).size)
				}),
			}),
		)
		expect(report.runs).toBe(30)
		expect(new Set(sizes)).toEqual(new Set([100]))
	})
})

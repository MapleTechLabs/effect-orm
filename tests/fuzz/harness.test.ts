import { Arbitrary, Schema } from "effect"
import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"
import { Gen } from "../../effect-prop/src/index"
import { config, FuzzFailure, property, skip, skipKnown } from "./harness"

const original = { ...config }
afterEach(() => Object.assign(config, original))
// Infrastructure checks use fixed budgets regardless of a soak's environment.
const reset = () => Object.assign(config, { runs: undefined, scale: 1, seed: 1, path: undefined, replay: undefined, propReplay: undefined, failures: undefined, verbose: false })

describe("fuzz harness coverage guarantees", () => {
	it("refuses zero-run and invalid budgets for both generators", async () => {
		reset()
		config.runs = 0
		await expect(property("zero fast-check", fc.constant(1), () => {}, { runs: 1 })).rejects.toThrow("FUZZ_RUNS")
		await expect(property("zero native", Arbitrary.Constant(1), () => {}, { runs: 1 })).rejects.toThrow("FUZZ_RUNS")
		config.runs = undefined
		config.scale = Number.NaN
		await expect(property("invalid scale", fc.constant(1), () => {}, { runs: 1 })).rejects.toThrow("FUZZ_SCALE")
	})
	it("fails when all inputs hit a known issue", async () => {
		reset()
		await expect(property("all known", fc.constant(1), () => skipKnown("open-bug"), { runs: 1 })).rejects.toThrow("every input was skipped (open-bug)")
	})
	it("fails when all inputs exceed the oracle", async () => {
		reset()
		await expect(property("all outside oracle", fc.constant(1), () => skip("oracle limit"), { runs: 1 })).rejects.toThrow("every input was skipped (oracle limit)")
	})
	it("fails rather than passing a partially interrupted budget", async () => {
		reset()
		await expect(property("interrupted budget", fc.constant(1), async () => {
			await new Promise((resolve) => setTimeout(resolve, 10))
		}, { runs: 100, timeoutMs: 1 })).rejects.toThrow("interrupted budget")
	})
	it("native filters discard inputs without consuming the checked budget", async () => {
		reset()
		let checked = 0
		const arb = Arbitrary.schema(Schema.Literals([0, 1])).pipe(Arbitrary.filter((n) => n === 1))
		await property("filtered native", arb, (n) => { expect(n).toBe(1); checked++ }, { runs: 5 })
		expect(checked).toBe(5)
	})
	it("fails when a native generator discards every input", async () => {
		reset()
		let checked = 0
		await expect(property("all native discards", Arbitrary.Constant(1).pipe(Arbitrary.filter(() => false)), () => { checked++ }, { runs: 1 })).rejects.toThrow("Property exhausted after 0 run(s)")
		expect(checked).toBe(0)
	})
	it("explains that predicate-level skips need native generator filtering", async () => {
		reset()
		for (const discard of [skip, skipKnown]) {
			await expect(property("native predicate skip", Arbitrary.Constant(1), () => discard("outside oracle"), { runs: 1 })).rejects.toThrow("Native properties must use Arbitrary.filter")
		}
	})
	it("preserves native shrinking, failure context and replay", async () => {
		reset()
		const arb = Arbitrary.schema(Schema.Int)
		let failure = ""
		try {
			await property("native replay", arb, (n) => { throw new FuzzFailure("deliberate", { n, sql: "SELECT bad" }) }, { runs: 5 })
		} catch (error) { failure = String(error) }
		expect(failure).toContain("Shrunk input:")
		expect(failure).toContain("SELECT bad")
		const token = /FUZZ_REPLAY='([^']+)'/.exec(failure)?.[1]
		expect(token).toBeDefined()
		config.replay = token
		await expect(property("native replay", arb, () => { throw new FuzzFailure("deliberate", {}) }, { runs: 5 })).rejects.toThrow("Property falsified")
		await expect(property("native replay", arb, () => {}, { runs: 5 })).rejects.toThrow("PropertyPassed")
	})
	it("effect-prop: skips are discards, counted by reason, and a run of nothing but skips fails", async () => {
		reset()
		let checked = 0
		await property("guided mixed", Gen.int(0, 9), (n) => { if (n % 2 === 0) skip("even"); checked++ }, { runs: 20 })
		expect(checked).toBe(20)
		await expect(property("guided all known", Gen.constant(1), () => skipKnown("open-bug"), { runs: 1 })).rejects.toThrow("every input was skipped (open-bug)")
		config.runs = 0
		await expect(property("guided zero", Gen.constant(1), () => {}, { runs: 1 })).rejects.toThrow("FUZZ_RUNS")
		config.runs = undefined
		// A value that is no number used to stop the search before its first input, and pass.
		config.failures = Number.NaN
		await expect(property("guided bad failures", Gen.constant(1), () => {}, { runs: 1 })).rejects.toThrow("PROP_FAILURES")
	})
	it("effect-prop: a soak runs the scaled count, on the guided search", async () => {
		reset()
		config.scale = 3
		let checked = 0
		await property("guided soak", Gen.int(0, 9), () => { checked++ }, { runs: 20 })
		// The guided search runs a batch again to find which input was new, so the property runs at least once per input.
		expect(checked).toBeGreaterThanOrEqual(60)
		expect(checked).toBeLessThan(200)
	})
	it("effect-prop: reports each distinct failure once, shrunk, with its context and a replay command", async () => {
		reset()
		const predicate = (n: number) => {
			if (n > 700) throw new FuzzFailure("a valid plan was not compiled (Refused)", { error: `value ${n} is too large`, sql: "SELECT big" })
			if (n < -700) throw new FuzzFailure("expected [ 1 ] to deeply equal [ 2 ]", { outcome: { _tag: "DatabaseError", message: `Code: 62. near "${n}": doesn't parse at 14` }, sql: "SELECT bad" })
		}
		config.failures = 2
		let failure = ""
		try {
			await property("guided failures", Gen.int(-1000, 1000), predicate, { runs: 2000 })
		} catch (error) {
			failure = String(error)
		}
		expect(failure).toContain("2 distinct failures")
		// Grouped by what was said, with what varies per input taken out; each shrunk to its boundary.
		expect(failure).toMatch(/=== \d\. a valid plan was not compiled \(Refused\): value N is too large[^\n]*\nreplay: PROP_REPLAY='p1\.[0-9a-z.]+' bun run fuzz -t 'guided failures'\n--- input \(shrunk\)\n701\n/)
		expect(failure).toMatch(/=== \d\. DatabaseError: Code: 62\. near …[^\n]*\nreplay: [^\n]*\n--- input \(shrunk\)\n-701\n/)
		expect(failure).toContain("SELECT big")
		expect(failure).toContain("SELECT bad")
		const token = /=== \d\. a valid plan[^\n]*\nreplay: PROP_REPLAY='([^']+)'/.exec(failure)![1]!
		config.propReplay = token
		await expect(property("guided failures", Gen.int(-1000, 1000), predicate, { runs: 2000 })).rejects.toThrow(/found by replay[^]*--- input \(shrunk\)\n701\n/)
	})
	it("effect-prop: fails rather than passing a partially interrupted budget, and refuses the other engines' replay settings", async () => {
		reset()
		await expect(property("guided budget", Gen.int(), async () => {
			await new Promise((resolve) => setTimeout(resolve, 10))
		}, { runs: 100, timeoutMs: 30 })).rejects.toThrow("interrupted by its 30 ms budget")
		config.path = "0:1"
		await expect(property("guided path", Gen.int(), () => {}, { runs: 1 })).rejects.toThrow("replays with PROP_REPLAY")
	})
})

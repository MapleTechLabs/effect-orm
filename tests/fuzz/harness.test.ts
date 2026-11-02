import { Arbitrary, Schema } from "effect"
import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"
import { config, FuzzFailure, property, skip, skipKnown } from "./harness"

const original = { ...config }
afterEach(() => Object.assign(config, original))
// Infrastructure checks use fixed budgets regardless of a soak's environment.
const reset = () => Object.assign(config, { runs: undefined, scale: 1, seed: 1, path: undefined, replay: undefined, verbose: false })

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
})

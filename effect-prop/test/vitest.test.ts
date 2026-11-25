import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { Gen, Prop, Regressions } from "../src/index"
import { layerRegressions } from "../src/node"
import { prop } from "../src/vitest"

class Limit extends Context.Service<Limit, { readonly max: number }>()("test/Limit") {}

describe("prop", () => {
	prop("holds for a plain function", Gen.array(Gen.int()), (xs) => [...xs].sort((a, b) => a - b).length === xs.length, { regressions: false })

	prop(
		"provides its layer and a scope per input",
		Gen.int(0, 50),
		(n) => Effect.gen(function* () {
			yield* Effect.addFinalizer(() => Effect.void)
			return n <= (yield* Limit).max
		}),
		{ layer: Layer.succeed(Limit, { max: 50 }), regressions: false },
	)

	prop.skip("skip is skipped", Gen.int(), () => false)
})

describe("node regressions", () => {
	const directory = mkdtempSync(join(tmpdir(), "effect-prop-"))
	afterAll(() => rmSync(directory, { recursive: true, force: true }))

	it("writes one file per property and replays it first", async () => {
		const gen = Gen.array(Gen.int(0, 100))
		const check = (seed: number) =>
			Effect.runPromise(Prop.check(gen, (xs) => !xs.includes(42), { name: "files > no 42 (here)", runs: 3000, seed }).pipe(Effect.provide(layerRegressions(directory))))
		const first = await check(1)
		expect(first.failures[0]!.foundBy).toBe("search")
		const [file] = readdirSync(directory)
		expect(file).toMatch(/^files_no_42_here_\.[0-9a-z]+\.json$/)
		const stored = JSON.parse(readFileSync(join(directory, file!), "utf8"))
		expect(stored).toEqual({ property: "files > no 42 (here)", cases: [{ replay: first.failures[0]!.replay, signature: "ReturnedFalse", value: "[42]" }] })
		const second = await check(2)
		expect([second.failures[0]!.foundBy, second.runs]).toEqual(["regression", 1])
	})

	it("dies on a regression file it cannot read, naming the file", async () => {
		const holding = (text: string) => Regressions.make({ read: () => Effect.succeed(text), write: () => Effect.void })
		const load = (text: string) => Effect.runPromise(holding(text).load("p"))
		await expect(load(JSON.stringify({ property: "p", cases: [{ replay: "garbage", signature: "s", value: "v" }] }))).rejects.toThrow(/cannot read the regression file p\.\w+\.json: garbage is not a replay token/)
		await expect(load("<<<<<<< HEAD")).rejects.toThrow(/cannot read the regression file p\.\w+\.json/)
		await expect(load(JSON.stringify({ property: "p" }))).rejects.toThrow(/cannot read the regression file/)
		await expect(load(JSON.stringify({ property: "q", cases: [] }))).rejects.toThrow(/it belongs to "q"/)
	})

	it("keeps properties apart whose names differ only in punctuation", async () => {
		const gen = Gen.int(0, 100)
		await Effect.runPromise(
			Effect.gen(function* () {
				const less = yield* Prop.check(gen, (n) => n < 50, { name: "sort: a < b", runs: 500, seed: 1 })
				const more = yield* Prop.check(gen, (n) => n > 50 || n === 0, { name: "sort: a > b", runs: 500, seed: 1 })
				expect([less.failures[0]!.value, more.failures[0]!.value]).toEqual([50, 1])
				// Each replays its own failure, not the other's.
				const again = yield* Prop.check(gen, (n) => n < 50, { name: "sort: a < b", runs: 500, seed: 2 })
				expect(again.failures.map((f) => [f.value, f.foundBy])).toEqual([[50, "regression"]])
			}).pipe(Effect.provide(Regressions.layerMemory)),
		)
	})

	it("keeps the newer of two failures with one signature", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* Regressions.Regressions
				yield* store.save("p", { choices: [1], size: 1, signature: "s", value: "old" })
				yield* store.save("p", { choices: [2], size: 1, signature: "s", value: "new" })
				yield* store.save("p", { choices: [3], size: 1, signature: "t", value: "other" })
				expect((yield* store.load("p")).map((r) => r.value)).toEqual(["new", "other"])
			}).pipe(Effect.provide(Regressions.layerMemory)),
		)
	})
})

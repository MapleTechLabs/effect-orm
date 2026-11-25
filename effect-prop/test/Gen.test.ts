import { Arbitrary, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Gen, Source } from "../src/index"
import { relativePath } from "../src/internal"

const run = <A>(gen: Gen.Gen<A>, options: Source.SourceOptions): { value: A; source: Source.Source } => {
	const source = new Source.Source(options)
	return { value: gen.run(source), source }
}

describe("Source", () => {
	it("gives the same value for the same choices", () => {
		const gen = Gen.array(Gen.struct({ id: Gen.int(), name: Gen.string(), tags: Gen.array(Gen.element("a", "b", "c")) }))
		for (let seed = 0; seed < 50; seed++) {
			const first = run(gen, { rng: new Source.Rng(seed), size: 40 })
			const again = run(gen, { prefix: first.source.choices, size: 40 })
			expect(again.value).toEqual(first.value)
			expect(again.source.choices).toEqual(first.source.choices)
		}
	})

	it("is deterministic in the seed and differs between seeds", () => {
		const gen = Gen.array(Gen.int(), { minLength: 5 })
		expect(Gen.sample(gen, { seed: 7 })).toEqual(Gen.sample(gen, { seed: 7 }))
		expect(Gen.sample(gen, { seed: 7 })).not.toEqual(Gen.sample(gen, { seed: 8 }))
	})

	it("draws 0 past the prefix when it has no rng, the simplest value of every generator", () => {
		expect(run(Gen.int(-5, 5), {}).value).toBe(0)
		expect(run(Gen.int(3, 9), {}).value).toBe(3)
		expect(run(Gen.int(-9, -3), {}).value).toBe(-3)
		expect(run(Gen.array(Gen.int()), {}).value).toEqual([])
		expect(run(Gen.string({ minLength: 2 }), {}).value).toBe("aa")
		expect(run(Gen.number(), {}).value).toBe(0)
		expect(run(Gen.element("x", "y"), {}).value).toBe("x")
	})

	it("folds an out-of-range replayed choice into range", () => {
		expect(run(Gen.element("a", "b", "c"), { prefix: [7] }).value).toBe("b")
		expect(run(Gen.boolean, { prefix: [Number.NaN] }).value).toBe(false)
	})

	it("draws uniformly up to the full safe-integer range", () => {
		const rng = new Source.Rng(1)
		for (const max of [1, 2, 255, 0xffff_ffff, 0x1_0000_0000, 2 ** 40 + 3, Source.MAX_DRAW]) {
			let largest = 0
			for (let i = 0; i < 2000; i++) {
				const value = rng.upTo(max)
				expect(Number.isSafeInteger(value) && value >= 0 && value <= max).toBe(true)
				largest = Math.max(largest, value)
			}
			expect(largest).toBeGreaterThan(max / 2)
		}
	})

	it("round-trips a replay token and rejects anything else", () => {
		const recorded = { size: 37, choices: [0, 1, 35, 36, 4294967295, Source.MAX_DRAW] }
		expect(Source.decodeReplay(Source.encodeReplay(recorded))).toEqual(recorded)
		expect(Source.decodeReplay(Source.encodeReplay({ size: 1, choices: [] }))).toEqual({ size: 1, choices: [] })
		for (const bad of ["", "p1", "p2.1.2", "p1.1.-3", "p1.1.x y", "p1..3"]) expect(Source.decodeReplay(bad)).toBeUndefined()
	})
})

describe("Gen", () => {
	it("stays inside the bounds it was given", () => {
		const cases: ReadonlyArray<[Gen.Gen<number>, (n: number) => boolean]> = [
			[Gen.int(-3, 7), (n) => Number.isInteger(n) && n >= -3 && n <= 7],
			[Gen.int(5, 5), (n) => n === 5],
			[Gen.int(Number.MIN_SAFE_INTEGER + 1, 0), (n) => Number.isSafeInteger(n) && n <= 0],
			[Gen.number({ min: 0.5, max: 2.5 }), (n) => n >= 0.5 && n <= 2.5],
			[Gen.number({ min: 0.1, max: 0.2 }), (n) => n >= 0.1 && n <= 0.2],
			[Gen.number(), (n) => Number.isFinite(n)],
		]
		for (const [gen, valid] of cases) {
			const values = Gen.sample(gen, { count: 500, seed: 3 })
			// A generator that discards everything would otherwise pass on nothing.
			expect(values).toHaveLength(500)
			for (const value of values) expect(valid(value), String(value)).toBe(true)
		}
	})

	it("reaches both ends of an integer range and the special doubles", () => {
		const ints = new Set(Gen.sample(Gen.int(-1000, 1000), { count: 400, seed: 1 }))
		expect(ints.has(-1000) && ints.has(1000) && ints.has(0)).toBe(true)
		const doubles = Gen.sample(Gen.number({ nan: true, infinity: true }), { count: 3000, seed: 1 })
		expect(doubles.some(Number.isNaN)).toBe(true)
		expect(doubles.some((n) => n === Number.POSITIVE_INFINITY)).toBe(true)
		expect(doubles.some((n) => Object.is(n, -0))).toBe(true)
		expect(doubles.some((n) => !Number.isInteger(n) && Number.isFinite(n))).toBe(true)
	})

	it("respects array length bounds and grows with size", () => {
		for (const value of Gen.sample(Gen.array(Gen.boolean, { minLength: 2, maxLength: 4 }), { count: 300 })) {
			expect(value.length >= 2 && value.length <= 4).toBe(true)
		}
		const mean = (size: number): number => {
			const lengths = Gen.sample(Gen.array(Gen.boolean), { count: 400, size }).map((a) => a.length)
			return lengths.reduce((a, b) => a + b, 0) / lengths.length
		}
		expect(mean(100)).toBeGreaterThan(mean(5) * 2)
	})

	it("never produces a lone surrogate", () => {
		for (const value of Gen.sample(Gen.string(), { count: 500, size: 60 })) expect(value).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
	})

	it("uniqueArray has no duplicate keys and meets its minimum", () => {
		const gen = Gen.uniqueArray(Gen.struct({ id: Gen.int(0, 20), v: Gen.int() }), { key: (x) => x.id, minLength: 3 })
		for (const value of Gen.sample(gen, { count: 200 })) {
			expect(new Set(value.map((x) => x.id)).size).toBe(value.length)
			expect(value.length).toBeGreaterThanOrEqual(3)
		}
	})

	it("shuffled is a permutation; subsequence keeps order", () => {
		const items = [1, 2, 3, 4, 5, 6]
		for (const value of Gen.sample(Gen.shuffled(items), { count: 100 })) expect([...value].sort()).toEqual(items)
		for (const value of Gen.sample(Gen.subsequence(items), { count: 100 })) expect(value).toEqual([...value].sort())
		expect(new Set(Gen.sample(Gen.shuffled(items), { count: 100 }).map(String)).size).toBeGreaterThan(20)
	})

	it("weighted follows its weights but records only the index", () => {
		const gen = Gen.weighted([9, Gen.constant("common")], [1, Gen.constant("rare")], [0, Gen.constant("never")])
		const values = Gen.sample(gen, { count: 2000 })
		const rare = values.filter((v) => v === "rare").length
		expect(rare).toBeGreaterThan(100)
		expect(rare).toBeLessThan(350)
		expect(values).not.toContain("never")
		expect(run(gen, { prefix: [1] }).value).toBe("rare")
	})

	it("gen() sequences dependent generators", () => {
		const range = Gen.gen(function* () {
			const lo = yield* Gen.int(0, 10)
			const hi = yield* Gen.int(lo, 20)
			return [lo, hi] as const
		})
		for (const [lo, hi] of Gen.sample(range, { count: 300 })) expect(lo <= hi && hi <= 20).toBe(true)
	})

	it("filter discards after three rejected tries, and sample skips discards", () => {
		const even = Gen.int(0, 100).pipe(Gen.filter((n) => n % 2 === 0))
		for (const value of Gen.sample(even, { count: 200 })) expect(value % 2).toBe(0)
		const impossible = Gen.int().pipe(Gen.filter(() => false))
		expect(Gen.generate(impossible, new Source.Source({ rng: new Source.Rng(1) }))).toBeInstanceOf(Source.Discard)
		expect(Gen.sample(impossible)).toEqual([])
	})

	it("recursive stops at maxDepth and marks each node as a span", () => {
		type Tree = number | readonly [Tree, Tree]
		const depth = (t: Tree): number => (typeof t === "number" ? 0 : 1 + Math.max(depth(t[0]), depth(t[1])))
		const tree: Gen.Gen<Tree> = Gen.recursive<Tree>(Gen.int(0, 9), (self) => Gen.tuple(self, self), { maxDepth: 4, label: "tree" })
		const trees = Gen.sample(tree, { count: 300, seed: 2 })
		expect(Math.max(...trees.map(depth))).toBeLessThanOrEqual(4)
		expect(Math.max(...trees.map(depth))).toBeGreaterThanOrEqual(3)
		// One node over two leaves: recurse, then twice "stop" and a leaf's value.
		const { value, source } = run(tree, { prefix: [1, 0, 0, 0, 0] })
		expect(value).toEqual([0, 0])
		expect(source.spans.map((s) => [s.label, s.start, s.end])).toEqual([["tree", 1, 3], ["tree", 3, 5], ["tree", 0, 5]])
	})

	it("bridges an Effect Schema, deterministically in its seed draw", () => {
		const User = Schema.Struct({ id: Schema.Int, name: Schema.String, admin: Schema.Boolean })
		const gen = Gen.fromSchema(User)
		const decode = Schema.decodeUnknownSync(User)
		for (const value of Gen.sample(gen, { count: 50 })) expect(decode(value)).toEqual(value)
		expect(run(gen, { prefix: [1234] }).value).toEqual(run(gen, { prefix: [1234] }).value)
	})

	it("gives no negative zero in a range that starts at zero", () => {
		expect(Gen.sample(Gen.number({ min: 0, max: 10 }), { count: 5000 }).some((n) => Object.is(n, -0))).toBe(false)
		expect(Gen.sample(Gen.number({ min: -1, max: 1 }), { count: 5000 }).some((n) => Object.is(n, -0))).toBe(true)
	})

	it("rethrows what an Arbitrary's own callback throws, and discards when it only runs dry", () => {
		const throwing = Arbitrary.map(Arbitrary.schema(Schema.Int), () => {
			throw new Error("callback bug")
		})
		expect(() => Gen.sample(Gen.fromArbitrary(throwing), { count: 1 })).toThrow("callback bug")
		const dry = Arbitrary.filter(Arbitrary.schema(Schema.Int), () => false)
		expect(Gen.sample(Gen.fromArbitrary(dry), { count: 3 })).toEqual([])
	})

	it("struct makes a field of every key, and weights near the top of the range still choose", () => {
		const made = Gen.sample(Gen.struct({ ["__proto__"]: Gen.constant(1), a: Gen.constant(2) }), { count: 1 })[0]!
		expect(Object.keys(made)).toEqual(["__proto__", "a"])
		expect(Object.getPrototypeOf(made)).toBe(Object.prototype)
		const chosen = new Set(Gen.sample(Gen.weighted([1e308, Gen.constant("a")], [1e308, Gen.constant("b")]), { count: 200 }))
		expect(chosen).toEqual(new Set(["a", "b"]))
	})

	it("gen() runs the body's finally blocks when a yielded generator discards", () => {
		let closed = 0
		const gen = Gen.gen(function* () {
			try {
				return yield* Gen.int().pipe(Gen.filter(() => false))
			} finally {
				closed++
			}
		})
		expect(Gen.generate(gen, new Source.Source({ rng: new Source.Rng(1) }))).toBeInstanceOf(Source.Discard)
		expect(closed).toBe(1)
	})

	it("two recursive generators sharing a label each count their own depth", () => {
		type Tree = number | readonly [Tree]
		const depth = (t: Tree): number => (typeof t === "number" ? 0 : 1 + depth(t[0]))
		const inner = Gen.recursive<Tree>(Gen.constant(0), (self) => Gen.tuple(self), { maxDepth: 3, label: "node" })
		// The outer one is one level deep whenever it reaches `inner`, which must still get its own three.
		const outer = Gen.recursive<Tree>(Gen.constant(0), () => inner, { maxDepth: 1, label: "node" })
		expect(Math.max(...Gen.sample(outer, { count: 400, seed: 1 }).map(depth))).toBe(3)
	})

	it("names a file by its path under the working directory, from a path or a file URL of either platform", () => {
		expect(relativePath("/repo/src/a.ts", "/repo")).toBe("src/a.ts")
		expect(relativePath("file:///repo/src/a.ts", "/repo")).toBe("src/a.ts")
		expect(relativePath("file:///my%20repo/src/a.ts", "/my repo")).toBe("src/a.ts")
		expect(relativePath("file:///C:/repo/src/a.ts", "C:\\repo")).toBe("src/a.ts")
		expect(relativePath("C:\\repo\\src\\a.ts", "C:\\repo")).toBe("src/a.ts")
		expect(relativePath("/elsewhere/a.ts", "/repo")).toBe("/elsewhere/a.ts")
		expect(relativePath("/repository/a.ts", "/repo")).toBe("/repository/a.ts")
	})

	it("unicodeChar reaches U+007F, and a size is a whole number", () => {
		expect(Gen.sample(Gen.unicodeChar, { count: 20_000, seed: 1 })).toContain("\u007f")
		expect(new Source.Source({ size: 1.5 }).size).toBe(2)
	})

	it("rejects ranges it cannot honour", () => {
		expect(() => Gen.array(Gen.constant(0), { minLength: Number.POSITIVE_INFINITY })).toThrow(RangeError)
		expect(() => Gen.array(Gen.boolean, { maxLength: 1.5 })).toThrow(RangeError)
		expect(Gen.sample(Gen.array(Gen.boolean, { maxLength: Number.POSITIVE_INFINITY }), { count: 3 })).toHaveLength(3)
		expect(() => Gen.uniqueArray(Gen.int(), { minLength: 5, maxLength: 2 })).toThrow(RangeError)
		expect(() => Gen.int(3, 1)).toThrow(RangeError)
		expect(() => Gen.int(0.5, 1)).toThrow(RangeError)
		expect(() => Gen.int(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toThrow(RangeError)
		expect(() => Gen.elements([])).toThrow(RangeError)
		expect(() => Gen.array(Gen.boolean, { minLength: 3, maxLength: 2 })).toThrow(RangeError)
	})
})

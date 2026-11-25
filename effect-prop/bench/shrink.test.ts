// Shrinking, compared with fast-check on the classic shrinking challenges
// (github.com/jlink/shrinking-challenge). Not part of the test suite:
//
//   PROP_BENCH=1 bunx vitest run effect-prop/bench --disable-console-intercept
//
// For each challenge and each of 30 seeds, both libraries search until the
// property fails and shrink. The table shows how often each found a failure, the
// median size of the shrunk input (its JSON length) and how often it reached the
// known smallest input.
import { Effect } from "effect"
import fc from "fast-check"
import { describe, it } from "vitest"
import { Gen, Prop } from "../src/index"

interface Challenge<A> {
	readonly name: string
	readonly gen: Gen.Gen<A>
	readonly arb: fc.Arbitrary<A>
	readonly holds: (value: A) => boolean
	readonly smallest: (value: A) => boolean
}

type Expr = { readonly k: "lit"; readonly v: number } | { readonly k: "add" | "div"; readonly l: Expr; readonly r: Expr }
const evaluate = (e: Expr): number => {
	if (e.k === "lit") return e.v
	if (e.k === "add") return evaluate(e.l) + evaluate(e.r)
	const divisor = evaluate(e.r)
	if (divisor === 0) throw new Error("division by zero")
	return Math.trunc(evaluate(e.l) / divisor)
}
/** The challenge excludes a literal zero divisor, so the failure needs a divisor that only evaluates to zero. */
const noLiteralZeroDivisor = (e: Expr): boolean => e.k === "lit" || ((e.k !== "div" || e.r.k !== "lit" || e.r.v !== 0) && noLiteralZeroDivisor(e.l) && noLiteralZeroDivisor(e.r))
const size = (e: Expr): number => (e.k === "lit" ? 1 : 1 + size(e.l) + size(e.r))

const int16 = Gen.int(-32768, 32767)
const fcInt16 = fc.integer({ min: -32768, max: 32767 })
const sum16 = (xs: ReadonlyArray<number>): number => {
	let total = 0
	for (const x of xs) total = ((total + x + 32768) & 0xffff) - 32768
	return total
}

const challenges: ReadonlyArray<Challenge<any>> = [
	{
		name: "reverse",
		gen: Gen.array(Gen.int()),
		arb: fc.array(fc.integer()),
		holds: (xs: Array<number>) => [...xs].reverse().join() === xs.join(),
		smallest: (xs: Array<number>) => xs.length === 2 && xs.join() === "0,1",
	},
	{
		name: "distinct",
		gen: Gen.array(Gen.int()),
		arb: fc.array(fc.integer()),
		holds: (xs: Array<number>) => new Set(xs).size < 3,
		smallest: (xs: Array<number>) => xs.length === 3 && [...xs].sort((a, b) => a - b).join() === "-1,0,1" || xs.join() === "0,1,2",
	},
	{
		name: "nestedlists",
		gen: Gen.array(Gen.array(Gen.int())),
		arb: fc.array(fc.array(fc.integer())),
		holds: (xss: Array<Array<number>>) => xss.reduce((n, xs) => n + xs.length, 0) <= 10,
		smallest: (xss: Array<Array<number>>) => xss.length === 1 && xss[0]!.length === 11 && xss[0]!.every((x) => x === 0),
	},
	{
		name: "lengthlist",
		gen: Gen.gen(function* () {
			const length = yield* Gen.int(1, 100)
			return yield* Gen.array(Gen.int(0, 1000), { minLength: length, maxLength: length })
		}),
		arb: fc.integer({ min: 1, max: 100 }).chain((length) => fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: length, maxLength: length })),
		holds: (xs: Array<number>) => Math.max(...xs) < 900,
		smallest: (xs: Array<number>) => xs.join() === "900",
	},
	{
		name: "bound5",
		gen: Gen.tuple(...Array.from({ length: 5 }, () => Gen.array(int16).pipe(Gen.filter((xs) => sum16(xs) < 256)))),
		arb: fc.tuple(...Array.from({ length: 5 }, () => fc.array(fcInt16).filter((xs) => sum16(xs) < 256))),
		holds: (xss: Array<Array<number>>) => sum16(xss.flat()) < 5 * 256,
		smallest: (xss: Array<Array<number>>) => xss.flat().length === 2 && xss.flat().reduce((a, b) => a + b, 0) === -32769,
	},
	{
		name: "calculator",
		gen: Gen.recursive<Expr>(
			Gen.map(Gen.int(-10, 10), (v) => ({ k: "lit", v }) as const),
			(self) => Gen.struct({ k: Gen.element("add", "div"), l: self, r: self }),
			{ maxDepth: 6 },
		).pipe(Gen.filter(noLiteralZeroDivisor)),
		arb: fc.letrec<{ expr: Expr }>((tie) => ({
			expr: fc.oneof(
				{ maxDepth: 6 },
				fc.integer({ min: -10, max: 10 }).map((v): Expr => ({ k: "lit", v })),
				fc.record({ k: fc.constantFrom("add" as const, "div" as const), l: tie("expr"), r: tie("expr") }),
			),
		})).expr.filter(noLiteralZeroDivisor),
		holds: (e: Expr) => {
			evaluate(e)
			return true
		},
		smallest: (e: Expr) => size(e) === 5,
	},
]

const SEEDS = 30
const RUNS = 5000
const median = (xs: ReadonlyArray<number>): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? Number.NaN

describe.skipIf(process.env.PROP_BENCH === undefined)("shrinking challenges", () => {
	it("effect-prop against fast-check", async () => {
		const rows: Array<Record<string, string | number>> = []
		for (const challenge of challenges) {
			const ours: Array<unknown> = []
			const theirs: Array<unknown> = []
			let ourMs = 0
			let theirMs = 0
			for (let seed = 1; seed <= SEEDS; seed++) {
				let started = performance.now()
				const report = await Effect.runPromise(Prop.check(challenge.gen, challenge.holds, { runs: RUNS, seed }))
				ourMs += performance.now() - started
				if (report.failures.length > 0) ours.push(report.failures[0]!.value)
				started = performance.now()
				const details = fc.check(fc.property(challenge.arb, challenge.holds), { numRuns: RUNS, seed })
				theirMs += performance.now() - started
				if (details.failed) theirs.push(details.counterexample![0])
			}
			const describeSide = (found: ReadonlyArray<unknown>, ms: number) => ({
				found: `${found.length}/${SEEDS}`,
				"median size": median(found.map((v) => JSON.stringify(v).length)),
				smallest: `${found.filter(challenge.smallest).length}/${found.length}`,
				"ms/seed": Math.round(ms / SEEDS),
			})
			rows.push({ challenge: challenge.name, library: "effect-prop", ...describeSide(ours, ourMs) })
			rows.push({ challenge: challenge.name, library: "fast-check", ...describeSide(theirs, theirMs) })
		}
		console.table(rows)
	}, 600_000)
})

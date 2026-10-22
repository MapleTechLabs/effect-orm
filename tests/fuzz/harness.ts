// The fuzz harness: one `property` wrapper every fuzz suite runs through.
//
// It exists so a failure is cheap to act on. fast-check already shrinks the input;
// this adds the rest of the loop:
//
//   - budget and seed come from the environment, so the same test is a 50-run
//     smoke check in `bun run test` and a 50 000-run soak under `bun run fuzz`;
//   - a failure prints the shrunk input, the SQL it compiled to, and the exact
//     command that replays it (`FUZZ_SEED`, `FUZZ_PATH`);
//   - inputs pinned in `regressions.ts` are replayed before any random one, so
//     a counterexample stays a test after the bug is fixed;
//   - `known` issues are skipped by name (see `known-issues.ts`), and
//     `FUZZ_STRICT=1` turns them back on to check whether one is fixed.
import fc from "fast-check"
import { pinnedFor } from "./regressions"

const int = (name: string): number | undefined => {
	const raw = process.env[name]
	return raw === undefined || raw === "" ? undefined : Number.parseInt(raw, 10)
}

export const config = {
	/** Multiplies every property's own default run count. */
	scale: Number.parseFloat(process.env.FUZZ_SCALE ?? "1"),
	runs: int("FUZZ_RUNS"),
	seed: int("FUZZ_SEED"),
	path: process.env.FUZZ_PATH || undefined,
	strict: process.env.FUZZ_STRICT === "1",
	verbose: process.env.FUZZ_VERBOSE === "1",
}

/**
 * What a predicate attaches to its failure: the compiled SQL and params, or
 * anything else that makes the counterexample readable without a debugger.
 */
export class FuzzFailure extends Error {
	constructor(
		message: string,
		readonly context: Record<string, unknown>,
	) {
		super(message)
	}
}

/** Run `body`, and if it throws, attach `context` to the error. */
export const withContext = async <A>(context: Record<string, unknown>, body: () => A | Promise<A>): Promise<A> => {
	try {
		return await body()
	} catch (error) {
		if (error instanceof FuzzFailure) throw error
		const message = error instanceof Error ? error.message : String(error)
		throw new FuzzFailure(message, context)
	}
}

/** Thrown to discard an input, like `fc.pre`, but with a reason the stats can count. */
export class Skip extends Error {
	constructor(
		readonly reason: string,
		readonly known: boolean,
	) {
		super(`skipped: ${reason}`)
	}
}
/** Discard an input the oracle cannot judge (a generator or harness limit). */
export const skip = (reason: string): never => {
	throw new Skip(reason, false)
}
/** Discard an input that reaches an open bug in `known-issues.ts`. */
export const skipKnown = (issue: string): never => {
	throw new Skip(issue, true)
}

/** Straight to stdout: this suite's vitest setup swallows `console.*` from passing tests. */
const report = (line: string) => process.stdout.write(`${line}\n`)

const describeContext = (context: Record<string, unknown>): string =>
	Object.entries(context)
		.map(([key, value]) => `--- ${key}\n${typeof value === "string" ? value : fc.stringify(value)}`)
		.join("\n")

export interface PropertyOptions<T> {
	/** Runs at FUZZ_SCALE=1 when FUZZ_RUNS is unset. */
	readonly runs: number
	readonly timeoutMs?: number
}

/**
 * Check `predicate` over `arb`, throwing a report a person can act on.
 *
 * Inputs the predicate `skip`s are discarded rather than counted; if most are,
 * the generator is wrong and the run says so instead of passing on nothing.
 */
export const property = async <T>(
	name: string,
	arb: fc.Arbitrary<T>,
	predicate: (input: T) => void | Promise<void>,
	options: PropertyOptions<T>,
): Promise<void> => {
	const skips = new Map<string, number>()
	const knownSkips = new Set<string>()
	let checked = 0
	const details = await fc.check(
		fc.asyncProperty(arb, async (input) => {
			try {
				await predicate(input)
				checked++
			} catch (error) {
				if (error instanceof Skip) {
					skips.set(error.reason, (skips.get(error.reason) ?? 0) + 1)
					if (error.known) knownSkips.add(error.reason)
					fc.pre(false)
				}
				throw error
			}
		}),
		{
			numRuns: config.runs ?? Math.max(1, Math.round(options.runs * config.scale)),
			...(config.seed !== undefined ? { seed: config.seed } : {}),
			...(config.path !== undefined ? { path: config.path } : {}),
			examples: pinnedFor(name).map((input) => [input as T]),
			interruptAfterTimeLimit: options.timeoutMs,
			maxSkipsPerRun: 1000,
			endOnFailure: false,
		},
	)
	if (config.verbose || details.failed) {
		const skipped = [...skips].map(([reason, count]) => `${count}× ${reason}`).join(", ")
		report(`[fuzz] ${name}: ${checked} checked${skipped ? `, skipped ${skipped}` : ""}`)
	}
	// fast-check fails a run whose every input was discarded; say why instead.
	if (checked === 0 && details.numSkips > 0 && details.counterexample === null) {
		// A property an open bug covers entirely is the backlog doing its job, not a broken generator.
		if (knownSkips.size > 0) {
			report(`[fuzz] ${name}: every input hits a known issue (${[...knownSkips].join(", ")})`)
			return
		}
		throw new Error(`[fuzz] ${name}: every input was skipped (${[...skips.keys()].join(", ")})`)
	}
	if (!details.failed) return

	const error = details.errorInstance
	const counterexample = details.counterexample?.[0]
	const replay = `FUZZ_SEED=${details.seed} FUZZ_PATH=${details.counterexamplePath} bun run fuzz -t ${JSON.stringify(name)}`
	throw new Error(
		[
			`[fuzz] ${name} failed after ${details.numRuns} runs (${details.numShrinks} shrinks)`,
			`replay: ${replay}`,
			"--- input (shrunk)",
			fc.stringify(counterexample),
			"--- error",
			error instanceof Error ? error.message : String(error),
			error instanceof FuzzFailure ? describeContext(error.context) : "",
			`--- pin it: add the input above to tests/fuzz/regressions.ts under a key matching ${JSON.stringify(name)}`,
		].join("\n"),
	)
}

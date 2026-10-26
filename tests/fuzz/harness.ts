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
//   - `known` issues are skipped by name (see `known-issues.ts`);
//     `FUZZ_STRICT=1` turns them all back on, `FUZZ_STRICT=<id>,<id>` just those.
import fc from "fast-check"
import { Arbitrary, Effect } from "effect"
import { pinnedFor } from "./regressions"

const int = (name: string): number | undefined => {
	const raw = process.env[name]
	return raw === undefined || raw === "" ? undefined : Number(raw)
}

export const config = {
	/** Multiplies every property's own default run count. */
	scale: Number(process.env.FUZZ_SCALE ?? "1"),
	runs: int("FUZZ_RUNS"),
	seed: int("FUZZ_SEED"),
	path: process.env.FUZZ_PATH || undefined,
	/** Native Effect Arbitrary replay token; separate from fast-check shrink paths. */
	replay: process.env.FUZZ_REPLAY || undefined,
	/** `1`: ignore every known issue. A comma list of ids: ignore just those (to verify one fix). */
	strict: new Set((process.env.FUZZ_STRICT ?? "").split(",").filter(Boolean)),
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

const runCount = (runs: number): number => {
	if (config.runs === undefined && (!Number.isFinite(config.scale) || config.scale <= 0)) {
		throw new Error("FUZZ_SCALE must be a positive finite number")
	}
	const count = config.runs ?? Math.max(1, Math.round(runs * config.scale))
	if (!Number.isSafeInteger(count) || count < 1) throw new Error("FUZZ_RUNS must be a positive safe integer")
	return count
}

/**
 * Check `predicate` over `arb`, throwing a report a person can act on.
 *
 * Inputs the predicate `skip`s are discarded rather than counted; if most are,
 * the generator is wrong and the run says so instead of passing on nothing.
 */
export const property = async <T>(
	name: string,
	arb: fc.Arbitrary<T> | Arbitrary.Arbitrary<T>,
	predicate: (input: T) => void | Promise<void>,
	options: PropertyOptions<T>,
): Promise<void> => {
	if (Arbitrary.isArbitrary(arb)) return nativeProperty(name, arb, predicate, options)
	if (config.replay !== undefined) throw new Error("FUZZ_REPLAY is for Effect properties; select one with -t")
	const skips = new Map<string, number>()
	let checked = 0
	const details = await fc.check(
		fc.asyncProperty(arb, async (input) => {
			try {
				await predicate(input)
				checked++
			} catch (error) {
				if (error instanceof Skip) {
					skips.set(error.reason, (skips.get(error.reason) ?? 0) + 1)
					fc.pre(false)
				}
				throw error
			}
		}),
		{
			numRuns: runCount(options.runs),
			...(config.seed !== undefined ? { seed: config.seed } : {}),
			...(config.path !== undefined ? { path: config.path } : {}),
			examples: pinnedFor(name).map((input) => [input as T]),
			interruptAfterTimeLimit: options.timeoutMs,
			markInterruptAsFailure: true,
			maxSkipsPerRun: 1000,
			endOnFailure: false,
		},
	)
	if (config.verbose || details.failed) {
		const skipped = [...skips].map(([reason, count]) => `${count}× ${reason}`).join(", ")
		report(`[fuzz] ${name}: ${checked} checked${skipped ? `, skipped ${skipped}` : ""}`)
	}
	if (checked === 0 && details.numSkips > 0 && details.counterexample === null) {
		throw new Error(`[fuzz] ${name}: every input was skipped (${[...skips.keys()].join(", ")})`)
	}
	if (!details.failed) return

	const error = details.errorInstance
	const counterexample = details.counterexample?.[0]
	// vitest reads `-t` as a regex, and names like `plans match the model (postgres, …)` have metacharacters.
	const pattern = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const replay = `FUZZ_SEED=${details.seed} FUZZ_PATH=${details.counterexamplePath} bun run fuzz -t '${pattern}'`
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

/** Shared budgets and replay for native properties, including TestSchema assertions. */
export const effectOptions = (runs: number): Arbitrary.CheckOptions => ({
	runs: runCount(runs),
	...(config.seed !== undefined ? { seed: config.seed } : {}),
	...(config.replay !== undefined ? { replay: config.replay } : {}),
})

/** Native Effect generation retains its own shrinking and opaque replay token. */
const nativeProperty = async <T>(
	name: string,
	arb: Arbitrary.Arbitrary<T>,
	predicate: (input: T) => void | Promise<void>,
	options: PropertyOptions<T>,
): Promise<void> => {
	if (config.path !== undefined) throw new Error("FUZZ_PATH is for fast-check properties; select one with -t")
	const evaluate = async (input: T): Promise<void> => {
		try { await predicate(input) } catch (error) {
			// Effect only discards during generation; a property failure is always falsified.
			if (error instanceof Skip) throw new FuzzFailure("Native properties must use Arbitrary.filter to discard inputs; skip()/skipKnown() cannot discard after evaluation", { reason: error.reason })
			throw error
		}
	}
	// Pinned examples are independent of the generator and must keep working after changes to it.
	for (const input of pinnedFor(name)) await evaluate(input as T)
	const check = Arbitrary.checkEffect(arb, (input) => Effect.tryPromise({
		try: async () => { await evaluate(input); return true },
		catch: (error) => error,
	}), effectOptions(options.runs))
	const result = await Effect.runPromise(options.timeoutMs === undefined ? check : check.pipe(Effect.timeout(options.timeoutMs)))
	if (config.verbose) report(`[fuzz] ${name}: ${"runs" in result ? result.runs : 0} checked (Effect Arbitrary)`)
	if (result._tag === "Passed") return
	const failure = Arbitrary.formatCheckFailure(result)
	const context = result._tag === "Falsified" && result.failure._tag === "PropertyError" && result.failure.error instanceof FuzzFailure
		? describeContext(result.failure.error.context) : ""
	const pattern = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const replay = result._tag === "Falsified"
		? `FUZZ_REPLAY='${result.replay}' bun run fuzz -t '${pattern}'`
		: ""
	throw new Error(`[fuzz] ${name}\n${failure}\n${context}\n${replay}`)
}

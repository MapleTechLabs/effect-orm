// Checking a generator before trusting it.
//
// A property is only as good as its inputs: a generator that discards most of
// its tries, builds invalid values, or barely varies finds nothing while every
// run stays green. `inspect` samples a generator and says which of those it does.
import { Formatter } from "effect"
import * as Gen from "./Gen"
import { Discard, Rng, sizeAt, Source } from "./Source"

export interface InspectOptions<A> {
	/** Tries, counting discards. Default 2000. */
	readonly samples?: number | undefined
	readonly seed?: number | undefined
	/** What every generated value must satisfy. */
	readonly valid?: ((value: A) => boolean) | undefined
	/** The classes a value belongs to, counted in the result. */
	readonly label?: ((value: A) => string | ReadonlyArray<string>) | undefined
	/** Labels that must each be produced at least once. */
	readonly expect?: ReadonlyArray<string> | undefined
	/** When two values are the same. Default: they print the same. */
	readonly key?: ((value: A) => string) | undefined
}

export interface Inspection<A> {
	readonly tries: number
	readonly generated: number
	readonly discarded: number
	readonly distinct: number
	/** Values `valid` rejected, the first few. */
	readonly invalid: ReadonlyArray<A>
	readonly labels: Readonly<Record<string, number>>
	/** Draws per value. */
	readonly choices: { readonly min: number; readonly median: number; readonly max: number }
	/** What is wrong with the generator. Empty when nothing is. */
	readonly problems: ReadonlyArray<string>
}

const MAX_DISCARD_RATE = 0.2

export const inspect = <A>(gen: Gen.Gen<A>, options: InspectOptions<A> = {}): Inspection<A> => {
	const tries = options.samples ?? 2000
	const key = options.key ?? ((value: A): string => Formatter.format(value))
	const rng = new Rng(options.seed ?? 0)
	const seen = new Set<string>()
	const labels: Record<string, number> = {}
	const invalid: Array<A> = []
	const lengths: Array<number> = []
	let invalidCount = 0
	let discarded = 0
	for (let i = 0; i < tries; i++) {
		const generated = Gen.generate(gen, new Source({ rng: rng.fork(), size: sizeAt(i) }))
		if (generated instanceof Discard) {
			discarded++
			continue
		}
		lengths.push(generated.choices.length)
		seen.add(key(generated.value))
		if (options.valid !== undefined && !options.valid(generated.value)) {
			invalidCount++
			if (invalid.length < 5) invalid.push(generated.value)
		}
		const named = options.label?.(generated.value) ?? []
		for (const each of typeof named === "string" ? [named] : named) labels[each] = (labels[each] ?? 0) + 1
	}
	const generated = tries - discarded
	lengths.sort((a, b) => a - b)
	const problems: Array<string> = []
	if (generated === 0) problems.push(`every one of ${tries} tries was discarded`)
	else if (discarded / tries > MAX_DISCARD_RATE) problems.push(`${((100 * discarded) / tries).toFixed(0)}% of tries are discarded: build valid values instead of filtering`)
	if (invalidCount > 0) problems.push(`${invalidCount} of ${generated} values are invalid, for example ${key(invalid[0]!)}`)
	// Few distinct values is not itself a problem (a boolean has two): say what must appear with `expect`.
	if (generated > 1 && seen.size === 1) problems.push(`all ${generated} values are the same: ${[...seen][0]}`)
	const missing = (options.expect ?? []).filter((each) => labels[each] === undefined)
	if (missing.length > 0) problems.push(`never produced: ${missing.join(", ")}`)
	return {
		tries,
		generated,
		discarded,
		distinct: seen.size,
		invalid,
		labels,
		choices: { min: lengths[0] ?? 0, median: lengths[Math.floor(lengths.length / 2)] ?? 0, max: lengths.at(-1) ?? 0 },
		problems,
	}
}

// Generators: pure descriptions of how to build a value from a `Source`.
//
// A generator is synchronous on purpose. A search runs it tens of thousands of
// times, and every shrink and mutation step runs it again, so it must cost
// nothing beyond the draws it makes. Effects belong in the property.
//
// Write generators so that smaller draws mean simpler values: put the simplest
// alternative first in `oneOf`, the base case first in `recursive`. Shrinking
// then needs no per-type code.
import { Arbitrary, Cause, Effect, Exit, type Schema } from "effect"
import { dual } from "effect/Function"
import { type Pipeable, pipeArguments } from "effect/Pipeable"
import { type Choices, Discard, MAX_DRAW, Rng, Source, type Span } from "./Source"

export const TypeId = "~effect-prop/Gen"

export interface Gen<out A> extends Pipeable {
	readonly [TypeId]: typeof TypeId
	readonly run: (source: Source) => A
	[Symbol.iterator](): Generator<Gen<A>, A>
}

/** The value type of a generator. */
export type Type<G> = G extends Gen<infer A> ? A : never

const Proto = {
	[TypeId]: TypeId,
	*[Symbol.iterator](this: Gen<unknown>): Generator<Gen<unknown>, unknown> {
		return yield this
	},
	pipe() {
		return pipeArguments(this, arguments)
	},
}

/** A generator from a function of the source. The primitive every other generator is built on. */
export const make = <A>(run: (source: Source) => A): Gen<A> => Object.assign(Object.create(Proto), { run })

/**
 * Generators in sequence, with plain control flow between them:
 *
 * ```ts
 * const range = Gen.gen(function* () {
 * 	const lo = yield* Gen.int(0, 10)
 * 	const hi = yield* Gen.int(lo, 20)
 * 	return [lo, hi] as const
 * })
 * ```
 */
export const gen = <A>(body: () => Generator<Gen<any>, A>): Gen<A> =>
	make((source) => {
		const iterator = body()
		let step = iterator.next()
		while (!step.done) step = iterator.next(step.value.run(source))
		return step.value
	})

export const isGen = (u: unknown): u is Gen<unknown> => typeof u === "object" && u !== null && TypeId in u

// Combinators

export const constant = <const A>(value: A): Gen<A> => make(() => value)

export const map: {
	<A, B>(f: (a: A) => B): (self: Gen<A>) => Gen<B>
	<A, B>(self: Gen<A>, f: (a: A) => B): Gen<B>
} = dual(2, <A, B>(self: Gen<A>, f: (a: A) => B): Gen<B> => make((source) => f(self.run(source))))

export const flatMap: {
	<A, B>(f: (a: A) => Gen<B>): (self: Gen<A>) => Gen<B>
	<A, B>(self: Gen<A>, f: (a: A) => Gen<B>): Gen<B>
} = dual(2, <A, B>(self: Gen<A>, f: (a: A) => Gen<B>): Gen<B> => make((source) => f(self.run(source)).run(source)))

/** Rejects the input being built. Use sparingly: build valid values instead of filtering. */
export const discard = (reason = "discarded"): never => {
	throw new Discard(reason)
}

const FILTER_TRIES = 3

/** Keeps values `predicate` accepts. After three rejected tries the whole input is discarded. */
export const filter: {
	<A, B extends A>(refinement: (a: A) => a is B): (self: Gen<A>) => Gen<B>
	<A>(predicate: (a: A) => boolean): (self: Gen<A>) => Gen<A>
	<A, B extends A>(self: Gen<A>, refinement: (a: A) => a is B): Gen<B>
	<A>(self: Gen<A>, predicate: (a: A) => boolean): Gen<A>
} = dual(
	2,
	<A>(self: Gen<A>, predicate: (a: A) => boolean): Gen<A> =>
		make((source) => {
			for (let attempt = 0; attempt < FILTER_TRIES; attempt++) {
				const value = source.span("filter", () => self.run(source))
				if (predicate(value)) return value
			}
			return discard("filter rejected every try")
		}),
)

/** Marks a generator's draws as one unit, so the shrinker can delete it or replace it with a nested unit of the same label. */
export const labeled: {
	(label: string): <A>(self: Gen<A>) => Gen<A>
	<A>(self: Gen<A>, label: string): Gen<A>
} = dual(2, <A>(self: Gen<A>, label: string): Gen<A> => make((source) => source.span(label, () => self.run(source))))

/** A generator that depends on the current size (0 to 100). */
export const sized = <A>(f: (size: number) => Gen<A>): Gen<A> => make((source) => f(source.size).run(source))

/** Defers building a generator until it runs: for self-reference. */
export const lazy = <A>(f: () => Gen<A>): Gen<A> => {
	let cached: Gen<A> | undefined
	return make((source) => (cached ??= f()).run(source))
}

// Numbers

const INT32_MIN = -0x8000_0000
const INT32_MAX = 0x7fff_ffff

/** An integer in `[min, max]`. Shrinks toward 0, or toward the bound nearest 0. */
export const int = (min: number = INT32_MIN, max: number = INT32_MAX): Gen<number> => {
	if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) throw new RangeError(`Gen.int: bounds must be safe integers, got ${min} and ${max}`)
	if (min > max) throw new RangeError(`Gen.int: min ${min} is greater than max ${max}`)
	const span = max - min
	if (span > MAX_DRAW) throw new RangeError(`Gen.int: range ${min}..${max} is wider than ${MAX_DRAW}`)
	const origin = Math.min(Math.max(0, min), max)
	const up = max - origin
	const down = origin - min
	const both = Math.min(up, down)
	return make((source) => {
		// 0, +1, -1, +2, -2, … from the origin, then the rest of the longer side.
		const d = source.drawBiased(span)
		if (d <= 2 * both) return d % 2 === 1 ? origin + (d + 1) / 2 : origin - d / 2
		const rest = d - 2 * both
		return up > down ? origin + both + rest : origin - both - rest
	})
}

/** An integer in `[0, max]`. */
export const nat = (max: number = INT32_MAX): Gen<number> => int(0, max)

export const boolean: Gen<boolean> = make((source) => source.bool())

/** `true` with probability `p`; shrinks to `false`. */
export const weightedBoolean = (p: number): Gen<boolean> => make((source) => source.bool(p))

const bitsToDouble = (high: number, low: number): number => {
	const view = new DataView(new ArrayBuffer(8))
	view.setUint32(0, high)
	view.setUint32(4, low)
	return view.getFloat64(0)
}

export interface NumberOptions {
	readonly min?: number | undefined
	readonly max?: number | undefined
	/** Include `NaN`. Default `false`. */
	readonly nan?: boolean | undefined
	/** Include `Infinity` and `-Infinity`. Default `false`. */
	readonly infinity?: boolean | undefined
}

/** A double: integers, simple fractions, boundary values and arbitrary bit patterns. Shrinks toward 0. */
export const number = (options: NumberOptions = {}): Gen<number> => {
	const lo = Math.max(options.min ?? -Number.MAX_VALUE, -Number.MAX_VALUE)
	const hi = Math.min(options.max ?? Number.MAX_VALUE, Number.MAX_VALUE)
	if (Number.isNaN(lo) || Number.isNaN(hi) || lo > hi) throw new RangeError(`Gen.number: invalid range ${lo}..${hi}`)
	const bounded = options.min !== undefined || options.max !== undefined
	// Wide enough for every integer a double holds exactly, narrow enough for one draw.
	const intLo = Math.max(Math.ceil(lo), -(2 ** 51))
	const intHi = Math.min(Math.floor(hi), 2 ** 51)
	const integers = intLo <= intHi ? int(intLo, intHi) : undefined
	const clamp = (x: number): number => Math.min(hi, Math.max(lo, x))
	const fraction = make((source) => {
		const whole = integers === undefined ? lo : integers.run(source)
		const denominator = [2, 4, 10, 100, 1000][source.draw(4)]!
		return clamp(whole + source.draw(denominator - 1) / denominator)
	})
	const uniform = make((source) => {
		// Weighted, not `lo + u * (hi - lo)`: the width of the range can overflow.
		const u = source.draw(MAX_DRAW) / (MAX_DRAW + 1)
		return clamp(lo * (1 - u) + hi * u)
	})
	const bits = make((source) => {
		const value = bitsToDouble(source.draw(0xffff_ffff), source.draw(0xffff_ffff))
		return Number.isFinite(value) ? value : value > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE
	})
	const boundaries: Array<number> = bounded
		? // `-0 >= 0` holds, so the range decides `-0` by whether it reaches below zero.
			[lo, hi, ...[0, -0, Number.MIN_VALUE, -Number.MIN_VALUE, Number.EPSILON].filter((x) => x >= lo && x <= hi && (!Object.is(x, -0) || lo < 0 || Object.is(lo, -0)))]
		: [-0, Number.MIN_VALUE, -Number.MIN_VALUE, Number.EPSILON, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]
	if (options.infinity === true) {
		if (options.max === undefined || options.max === Number.POSITIVE_INFINITY) boundaries.push(Number.POSITIVE_INFINITY)
		if (options.min === undefined || options.min === Number.NEGATIVE_INFINITY) boundaries.push(Number.NEGATIVE_INFINITY)
	}
	if (options.nan === true) boundaries.push(Number.NaN)
	return weighted(
		...(integers === undefined ? [] : [[4, integers] as const]),
		[3, fraction],
		[2, bounded ? uniform : bits],
		[1, elements(boundaries)],
	)
}

// Choice

/** One of the given values. Shrinks toward the first. */
export const elements = <const A>(values: ReadonlyArray<A>): Gen<A> => {
	if (values.length === 0) throw new RangeError("Gen.elements: needs at least one value")
	return make((source) => values[source.draw(values.length - 1)]!)
}

/** One of the given values. Shrinks toward the first. */
export const element = <const A extends ReadonlyArray<unknown>>(...values: A): Gen<A[number]> => elements(values)

/** One of the given generators, equally likely. Shrinks toward the first: put the simplest first. */
export const oneOf = <const G extends ReadonlyArray<Gen<any>>>(...gens: G): Gen<Type<G[number]>> => {
	if (gens.length === 0) throw new RangeError("Gen.oneOf: needs at least one generator")
	return make((source) => gens[source.draw(gens.length - 1)]!.run(source))
}

/** One of the given generators, chosen in proportion to its weight. Shrinks toward the first. */
export const weighted = <const G extends ReadonlyArray<readonly [weight: number, gen: Gen<any>]>>(...entries: G): Gen<Type<G[number][1]>> => {
	const usable = entries.filter(([weight]) => weight > 0)
	if (usable.length === 0) throw new RangeError("Gen.weighted: needs at least one entry with a positive weight")
	const total = usable.reduce((sum, [weight]) => sum + weight, 0)
	return make((source) => {
		// Only the index is recorded, so replay does not depend on the weights.
		const index = source.drawWith(usable.length - 1, (rng) => {
			let at = rng.float() * total
			for (let i = 0; i < usable.length; i++) {
				at -= usable[i]![0]
				if (at < 0) return i
			}
			return usable.length - 1
		})
		return usable[index]![1].run(source)
	})
}

/** `undefined`, or a value. Shrinks to `undefined`. */
export const option = <A>(self: Gen<A>): Gen<A | undefined> => make((source) => (source.bool() ? self.run(source) : undefined))

/** `null`, or a value. Shrinks to `null`. */
export const nullable = <A>(self: Gen<A>): Gen<A | null> => make((source) => (source.bool() ? self.run(source) : null))

// Collections

export interface ArrayOptions {
	readonly minLength?: number | undefined
	readonly maxLength?: number | undefined
}

/**
 * An array. Each optional element is one span holding its "one more?" draw and
 * its value, so the shrinker removes an element by deleting its span.
 */
export const array = <A>(item: Gen<A>, options: ArrayOptions = {}): Gen<Array<A>> => {
	const { min, max } = lengthRange("Gen.array", options)
	return make((source) => repeat(source, "item", min, max, () => item.run(source)))
}

const lengthRange = (name: string, options: ArrayOptions): { readonly min: number; readonly max: number } => {
	const min = options.minLength ?? 0
	const max = options.maxLength ?? Number.POSITIVE_INFINITY
	if (min < 0 || min > max) throw new RangeError(`${name}: invalid length range ${min}..${max}`)
	return { min, max }
}

/**
 * `min` to `max` values from `next`, each in a span of `label`: more at a
 * larger size. Past `min`, each value's span begins with its "one more?" draw.
 * For generators whose next element depends on the ones before it.
 */
export const repeat = <A>(source: Source, label: string, min: number, max: number, next: () => A): Array<A> => {
	const STOP = Symbol("stop")
	const out: Array<A> = []
	while (out.length < min) out.push(source.span(label, next))
	const average = Math.min(1 + source.size / 4, (max - min) / 2 + 0.5)
	const more = average / (average + 1)
	while (out.length < max) {
		const value = source.span(label, () => (source.bool(more) ? next() : STOP))
		if (value === STOP) break
		out.push(value as A)
	}
	return out
}

/** An array with no two elements sharing a key. */
export const uniqueArray = <A>(item: Gen<A>, options: ArrayOptions & { readonly key?: ((a: A) => unknown) | undefined } = {}): Gen<Array<A>> => {
	const key = options.key ?? ((a: A): unknown => a)
	const { min } = lengthRange("Gen.uniqueArray", options)
	return make((source) => {
		const seen = new Set<unknown>()
		const out: Array<A> = []
		for (const value of array(item, { maxLength: options.maxLength }).run(source)) {
			const k = key(value)
			if (seen.has(k)) continue
			seen.add(k)
			out.push(value)
		}
		// Top up to the minimum; a domain too small to supply it is discarded.
		for (let tries = 0; out.length < min; tries++) {
			if (tries > 10 * (min + 1)) discard("uniqueArray: not enough distinct values")
			const value = item.run(source)
			const k = key(value)
			if (seen.has(k)) continue
			seen.add(k)
			out.push(value)
		}
		return out
	})
}

/** Some of the given values, in their original order. Shrinks toward none. */
export const subsequence = <A>(values: ReadonlyArray<A>): Gen<Array<A>> => make((source) => values.filter(() => source.bool()))

/** The given values in a random order. Shrinks toward the original order. */
export const shuffled = <A>(values: ReadonlyArray<A>): Gen<Array<A>> =>
	make((source) => {
		const out = [...values]
		for (let i = out.length - 1; i > 0; i--) {
			const j = i - source.draw(i)
			const held = out[i]!
			out[i] = out[j]!
			out[j] = held
		}
		return out
	})

export const tuple = <const G extends ReadonlyArray<Gen<any>>>(...gens: G): Gen<{ -readonly [K in keyof G]: Type<G[K]> }> =>
	make((source) => gens.map((g) => g.run(source)) as any)

export const struct = <const F extends Record<string, Gen<any>>>(fields: F): Gen<{ -readonly [K in keyof F]: Type<F[K]> }> => {
	const entries = Object.entries(fields)
	return make((source) => {
		const out: Record<string, unknown> = {}
		for (const [name, g] of entries) out[name] = g.run(source)
		return out as any
	})
}

// Text

const LOWER = "abcdefghijklmnopqrstuvwxyz"
const ASCII = `${LOWER}${LOWER.toUpperCase()}0123456789 _-.,:;!?'"()[]{}<>/\\|@#$%^&*+=~\``

/** One character of the given alphabet. Shrinks toward its first character. */
export const charOf = (alphabet: string): Gen<string> => elements(Array.from(alphabet))

/** A printable ASCII character. Shrinks toward `a`. */
export const asciiChar: Gen<string> = charOf(ASCII)

const codePoint = (min: number, max: number): Gen<string> => map(int(min, max), (cp) => String.fromCodePoint(cp))

/** Any Unicode scalar value (never a lone surrogate), mostly ASCII. Shrinks toward `a`. */
export const unicodeChar: Gen<string> = weighted(
	[6, asciiChar],
	[1, codePoint(0x00, 0x1f)],
	[2, codePoint(0x80, 0x24f)],
	[2, oneOf(codePoint(0x250, 0xd7ff), codePoint(0xe000, 0xffff))],
	[1, codePoint(0x1_0000, 0x10_ffff)],
)

/** Lengths count characters (code points): one outside the BMP is two UTF-16 units. */
export interface StringOptions extends ArrayOptions {
	/** The generator of each character. Default `unicodeChar`. */
	readonly char?: Gen<string> | undefined
}

export const string = (options: StringOptions = {}): Gen<string> => map(array(options.char ?? unicodeChar, options), (chars) => chars.join(""))

// Recursion

let recursiveIds = 0
const depths = new WeakMap<Source, Map<string, number>>()

export interface RecursiveOptions {
	/** How deep `step` may nest. Default 5. */
	readonly maxDepth?: number | undefined
	/** The span label of each node. Default: unique to this generator. */
	readonly label?: string | undefined
}

/**
 * A recursive structure: `base` at the leaves, `step(self)` above them. Each
 * node is a labelled span, so the shrinker can replace a node with one of its
 * descendants.
 */
export const recursive = <A>(base: Gen<A>, step: (self: Gen<A>) => Gen<A>, options: RecursiveOptions = {}): Gen<A> => {
	const maxDepth = options.maxDepth ?? 5
	const label = options.label ?? `recursive#${recursiveIds++}`
	const self: Gen<A> = make((source) => {
		let perSource = depths.get(source)
		if (perSource === undefined) depths.set(source, (perSource = new Map()))
		const depth = perSource.get(label) ?? 0
		const levels = perSource
		return source.span(label, () => {
			// Deeper nodes recurse less, so sizes stay finite.
			if (depth >= maxDepth || !source.bool(0.7 / (1 + depth / 2))) return base.run(source)
			levels.set(label, depth + 1)
			try {
				return stepped.run(source)
			} finally {
				levels.set(label, depth)
			}
		})
	})
	const stepped = step(self)
	return self
}

// Bridges

/**
 * A generator from a function of a seed, for sources of values that have their
 * own randomness (fast-check, Effect `Arbitrary`). The seed is one draw, so
 * shrinking can only try other seeds: prefer native generators where a small
 * counterexample matters.
 */
export const fromSeed = <A>(f: (seed: number, size: number) => A): Gen<A> => make((source) => f(source.draw(0xffff_ffff), source.size))

/** A generator from an Effect `Arbitrary`. See `fromSeed` for how it shrinks. */
export const fromArbitrary = <A>(arbitrary: Arbitrary.Arbitrary<A>): Gen<A> =>
	fromSeed((seed, size) => {
		const exit = Effect.runSyncExit(Arbitrary.sampleEffect(arbitrary, { count: 1, seed, size }))
		if (Exit.isSuccess(exit) && exit.value.length === 1) return exit.value[0]!
		// Running out of tries is a discard; a callback of the arbitrary that threw is a bug to see.
		if (Exit.isFailure(exit) && !Cause.hasFails(exit.cause)) throw Cause.squash(exit.cause)
		return discard("Arbitrary produced no value")
	})

/** A generator of a Schema's decoded type, through `Arbitrary.schema`. See `fromSeed` for how it shrinks. */
export const fromSchema = <S extends Schema.Constraint>(schema: S): Gen<S["Type"]> => fromArbitrary(Arbitrary.schema(schema))

// Running

export interface Generated<A> {
	readonly value: A
	readonly choices: Choices
	/** The largest value each choice could have been. */
	readonly bounds: ReadonlyArray<number>
	readonly spans: ReadonlyArray<Span>
}

/** Runs a generator on a source: the value and the choices behind it, or the `Discard` that rejected it. */
export const generate = <A>(self: Gen<A>, source: Source): Generated<A> | Discard => {
	try {
		const value = self.run(source)
		return { value, choices: source.choices, bounds: source.bounds, spans: source.spans }
	} catch (error) {
		if (error instanceof Discard) return error
		throw error
	}
}

export interface SampleOptions {
	readonly count?: number | undefined
	readonly seed?: number | undefined
	readonly size?: number | undefined
}

/** Values of a generator, for looking at what it produces. Discarded tries are skipped. */
export const sample = <A>(self: Gen<A>, options: SampleOptions = {}): Array<A> => {
	const count = options.count ?? 10
	const rng = new Rng(options.seed ?? 0)
	const out: Array<A> = []
	for (let tries = 0; out.length < count && tries < count * 20 + 100; tries++) {
		const generated = generate(self, new Source({ rng: rng.fork(), size: options.size }))
		if (!(generated instanceof Discard)) out.push(generated.value)
	}
	return out
}

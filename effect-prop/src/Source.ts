// The source of every random decision a generator makes.
//
// A generator never calls a random number generator itself: it asks a `Source`
// for integers, and the source records each answer. That record (the "choices")
// is the input's identity. Running the same generator on the same choices gives
// the same value, so:
//
//   - replay is "run again on these choices";
//   - shrinking is "make the choices shorter or smaller and run again", which
//     works for every generator, including ones whose later draws depend on
//     earlier values;
//   - mutation, for coverage-guided search, is "edit the choices and run again".
//
// Generators are written so that smaller choices mean simpler values: 0 is
// always the simplest answer.

/** The recorded decisions behind one generated value. */
export type Choices = ReadonlyArray<number>

/** A contiguous run of choices one generator call made, used to shrink by structure. */
export interface Span {
	readonly label: string
	readonly start: number
	readonly end: number
	readonly depth: number
}

/** Thrown by a generator to reject the input being built (a failed `filter`, an `assume`). */
export class Discard {
	readonly _tag = "Discard"
	constructor(readonly reason: string) {}
}

/** The largest value `draw` accepts as `max`. */
export const MAX_DRAW = Number.MAX_SAFE_INTEGER

/** One input may not make more draws than this; a generator that would is discarded. */
export const MAX_CHOICES = 100_000

/** A small, fast, seedable generator (sfc32), enough for test-input generation. */
export class Rng {
	private a: number
	private b: number
	private c: number
	private d: number

	constructor(seed: number) {
		// splitmix32 spreads a single seed over the four words of state.
		let s = seed >>> 0
		const next = (): number => {
			s = (s + 0x9e3779b9) >>> 0
			let z = s
			z = Math.imul(z ^ (z >>> 16), 0x21f0aaad)
			z = Math.imul(z ^ (z >>> 15), 0x735a2d97)
			return (z ^ (z >>> 15)) >>> 0
		}
		this.a = next()
		this.b = next()
		this.c = next()
		this.d = next()
		for (let i = 0; i < 12; i++) this.uint32()
	}

	uint32(): number {
		const t = (((this.a + this.b) >>> 0) + this.d) >>> 0
		this.d = (this.d + 1) >>> 0
		this.a = this.b ^ (this.b >>> 9)
		this.b = (this.c + (this.c << 3)) >>> 0
		this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0
		this.c = (this.c + t) >>> 0
		return t
	}

	/** A uniform integer in `[0, max]`, for `max` up to `MAX_DRAW`. */
	upTo(max: number): number {
		if (max <= 0) return 0
		if (max <= 0xffffffff) {
			const range = max + 1
			// Rejection sampling: no modulo bias.
			const limit = Math.floor(0x1_0000_0000 / range) * range
			for (;;) {
				const x = this.uint32()
				if (x < limit) return x % range
			}
		}
		// 53 bits from two words; reject past `max`. The smallest all-ones mask
		// covering `max` keeps the expected number of tries under two.
		const bits = Math.floor(Math.log2(max)) + 1
		const highBits = bits - 32
		const highMask = highBits >= 21 ? 0x1fffff : (1 << highBits) - 1
		for (;;) {
			const x = (this.uint32() & highMask) * 0x1_0000_0000 + this.uint32()
			if (x <= max) return x
		}
	}

	/** A float in `[0, 1)`. */
	float(): number {
		return this.uint32() / 0x1_0000_0000
	}

	/** A new generator whose stream is independent of this one's. */
	fork(): Rng {
		return new Rng(this.uint32())
	}
}

const validChoice = (value: number | undefined): value is number =>
	value !== undefined && Number.isSafeInteger(value) && value >= 0

export interface SourceOptions {
	/** Choices to replay before anything else. */
	readonly prefix?: Choices | undefined
	/** Where draws past the prefix come from. Without one they are 0, the simplest answer. */
	readonly rng?: Rng | undefined
	/** How large generated values may be, 0 to 100. */
	readonly size?: number | undefined
}

export class Source {
	/** The answers actually given: the prefix as the generator read it, then fresh draws. */
	readonly choices: Array<number> = []
	/** The largest value each choice could have been: what a mutation may put in its place. */
	readonly bounds: Array<number> = []
	readonly spans: Array<Span> = []
	size: number
	private readonly prefix: Choices
	private readonly rng: Rng | undefined
	private readonly open: Array<{ readonly label: string; readonly start: number }> = []

	constructor(options: SourceOptions = {}) {
		this.prefix = options.prefix ?? []
		this.rng = options.rng
		this.size = Math.max(0, Math.min(100, options.size ?? 30))
	}

	/**
	 * An integer in `[0, max]`, chosen by `fresh` when not replayed. `fresh` shapes
	 * the distribution only: the result is what is recorded.
	 */
	drawWith(max: number, fresh: (rng: Rng) => number): number {
		const index = this.choices.length
		if (index >= MAX_CHOICES) throw new Discard(`more than ${MAX_CHOICES} draws for one input`)
		let value: number
		if (index < this.prefix.length) {
			const replayed = this.prefix[index]
			// An edited prefix can hold a value this draw cannot give: fold it into range.
			value = validChoice(replayed) ? (replayed > max ? replayed % (max + 1) : replayed) : 0
		} else {
			value = this.rng === undefined ? 0 : fresh(this.rng)
		}
		this.choices.push(value)
		this.bounds.push(max)
		return value
	}

	/** An integer in `[0, max]`, uniform when drawn fresh. */
	draw(max: number): number {
		if (!Number.isSafeInteger(max) || max < 0) throw new RangeError(`Source.draw: max must be a safe integer >= 0, got ${max}`)
		if (max === 0) return this.drawWith(0, () => 0)
		return this.drawWith(max, (rng) => rng.upTo(max))
	}

	/**
	 * An integer in `[0, max]` that favours the values bugs hide at: the ends of the
	 * range and small numbers. Only the result is recorded, so replay is exact.
	 */
	drawBiased(max: number): number {
		if (!Number.isSafeInteger(max) || max < 0) throw new RangeError(`Source.drawBiased: max must be a safe integer >= 0, got ${max}`)
		if (max === 0) return this.drawWith(0, () => 0)
		return this.drawWith(max, (rng) => {
			const kind = rng.upTo(15)
			if (kind === 0) return 0
			if (kind === 1) return max
			if (kind <= 5) return rng.upTo(Math.min(max, 16))
			if (kind === 6) return max - rng.upTo(Math.min(max, 16))
			return rng.upTo(max)
		})
	}

	/** `true` with probability `p` when drawn fresh; recorded as 1 or 0. */
	bool(p = 0.5): boolean {
		return this.drawWith(1, (rng) => (rng.float() < p ? 1 : 0)) === 1
	}

	/** Marks the draws `body` makes as one unit the shrinker can delete or replace. */
	span<A>(label: string, body: () => A): A {
		const start = this.choices.length
		const depth = this.open.length
		this.open.push({ label, start })
		try {
			return body()
		} finally {
			this.open.pop()
			if (this.choices.length > start) this.spans.push({ label, start, end: this.choices.length, depth })
		}
	}
}

/** The size of the `attempt`th input: sizes cycle from small to large, so every run mixes simple and complex inputs. */
export const sizeAt = (attempt: number): number => 1 + ((attempt * 3) % 100)

/** Shorter is simpler; at equal length, the first differing choice decides. */
export const compareChoices = (a: Choices, b: Choices): number => {
	if (a.length !== b.length) return a.length - b.length
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return a[i]! - b[i]!
	}
	return 0
}

/** What it takes to build one input again: its choices and the size they were read at. */
export interface Recorded {
	readonly choices: Choices
	readonly size: number
}

const REPLAY_VERSION = "p1"

/** A copy-pasteable token for a recorded input: `p1`, the size, then each choice, in base 36. */
export const encodeReplay = (recorded: Recorded): string =>
	[REPLAY_VERSION, recorded.size.toString(36), ...recorded.choices.map((c) => c.toString(36))].join(".")

/** The input a token from `encodeReplay` names, or `undefined` if it is not one. */
export const decodeReplay = (token: string): Recorded | undefined => {
	const [version, ...parts] = token.trim().split(".")
	if (version !== REPLAY_VERSION || parts.length === 0) return undefined
	const [size, ...choices] = parts.map((part) => (/^[0-9a-z]+$/.test(part) ? Number.parseInt(part, 36) : Number.NaN))
	return validChoice(size) && choices.every(validChoice) ? { size, choices } : undefined
}

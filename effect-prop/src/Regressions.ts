// Regressions: failures a property has had, replayed before any new input.
//
// A failure is stored as its choices, so replaying it costs one run of the
// generator. Choices belong to the generator that read them: after the
// generator changes, a stored record still builds a valid input, but perhaps
// not the one that failed. Pin an input that must keep its exact value with
// `examples` in the check's options.
import { Context, Effect, Layer, Schema } from "effect"
import { decodeReplay, encodeReplay, type Recorded } from "./Source"

export interface Regression extends Recorded {
	/** The failure group this input belonged to when it was saved. */
	readonly signature: string
	/** The value as it printed when saved, for the reader. */
	readonly value: string
}

export interface RegressionsService {
	readonly load: (property: string) => Effect.Effect<ReadonlyArray<Regression>>
	readonly save: (property: string, regression: Regression) => Effect.Effect<void>
}

const none: RegressionsService = { load: () => Effect.succeed([]), save: () => Effect.void }

/** Where failures are remembered. Defaults to nowhere. */
export const Regressions = Context.Reference<RegressionsService>("effect-prop/Regressions", { defaultValue: () => none })

const StoredFile = Schema.Struct({
	property: Schema.String,
	cases: Schema.Array(Schema.Struct({ replay: Schema.String, signature: Schema.String, value: Schema.String })),
})
const decodeStored = Schema.decodeUnknownSync(Schema.fromJsonString(StoredFile))

/** Where regression files live: a name to its text, and back. */
export interface Storage {
	/** The file's text, or `undefined` when there is none. */
	readonly read: (file: string) => Effect.Effect<string | undefined>
	readonly write: (file: string, text: string) => Effect.Effect<void>
}

/** A short, stable hash of a string (FNV-1a), in base 36. */
const hash = (text: string): string => {
	let h = 0x811c9dc5
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
	return (h >>> 0).toString(36)
}

/** Readable, and unique to the property: two names that differ only in punctuation must not share a file. */
const fileName = (property: string): string => `${property.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80)}.${hash(property)}.json`

/**
 * Regressions as one JSON file per property (commit them). One input is kept
 * per failure group: a newer one replaces the older.
 */
export const make = (storage: Storage): RegressionsService => {
	const read = Effect.fnUntraced(function* (property: string) {
		const file = fileName(property)
		const text = yield* storage.read(file)
		if (text === undefined) return []
		// A regression file that cannot be read is a broken test setup, not a pass.
		const unreadable = (why: string): never => {
			throw new Error(`effect-prop: cannot read the regression file ${file}: ${why}`)
		}
		let stored: typeof StoredFile.Type
		try {
			stored = decodeStored(text)
		} catch (error) {
			return unreadable(error instanceof Error ? error.message : String(error))
		}
		if (stored.property !== property) return unreadable(`it belongs to ${JSON.stringify(stored.property)}`)
		return stored.cases.map((entry): Regression => {
			const recorded = decodeReplay(entry.replay)
			return recorded === undefined ? unreadable(`${entry.replay} is not a replay token of this version`) : { ...recorded, signature: entry.signature, value: entry.value }
		})
	})
	return {
		load: read,
		save: Effect.fnUntraced(function* (property, regression) {
			const kept = (yield* read(property)).filter((r) => r.signature !== regression.signature)
			const stored: typeof StoredFile.Type = {
				property,
				cases: [...kept, regression].map((r) => ({ replay: encodeReplay(r), signature: r.signature, value: r.value })),
			}
			yield* storage.write(fileName(property), `${JSON.stringify(stored, null, "\t")}\n`)
		}),
	}
}

/** Regressions kept for the life of the layer: for tests of the checker itself. */
export const layerMemory: Layer.Layer<never> = Layer.sync(Regressions, () => {
	const files = new Map<string, string>()
	return make({
		read: (file) => Effect.sync(() => files.get(file)),
		write: (file, text) => Effect.sync(() => void files.set(file, text)),
	})
})

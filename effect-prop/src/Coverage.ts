// Code coverage as search feedback, from V8 itself (Node only).
//
// After every input the layer asks V8 which functions and branches ran since
// the last time it asked, and counts the ones no earlier input reached. That
// number is the input's novelty: `Search.coverage` keeps inputs that have any.
//
// V8 has one set of counters per isolate. Two checks collecting at once, or a
// check under `vitest --coverage`, read and reset each other's counters: run
// coverage-guided properties one at a time, in a run without `--coverage`.
import { readFile } from "node:fs/promises"
import { Session } from "node:inspector/promises"
import { SourceMap } from "node:module"
import { Effect, Layer } from "effect"
import { Feedback, type FeedbackService, type FileSummary } from "./Feedback"
import { relativePath } from "./internal"

export interface CoverageOptions {
	/** Which scripts count, by URL: the code under test, not the test or its dependencies. */
	readonly include: (url: string) => boolean
}

interface Range {
	readonly startOffset: number
	readonly endOffset: number
	readonly count: number
}

interface ScriptCoverage {
	readonly scriptId: string
	readonly url: string
	readonly functions: ReadonlyArray<{ readonly functionName: string; readonly ranges: ReadonlyArray<Range> }>
}

interface FunctionState {
	readonly name: string
	readonly offset: number
	reached: boolean
	/** Every branch V8 has reported for this function, as `start:end`, and whether an input took it. */
	readonly branches: Map<string, boolean>
}

interface ScriptState {
	readonly scriptId: string
	readonly functions: Map<number, FunctionState>
}

/** Accumulates coverage slices. Exported for tests; use `layer`. */
export class Tracker {
	readonly scripts = new Map<string, ScriptState>()
	/** Marks what the last uncommitted slice found as reached. */
	private suspects: Array<() => void> = []
	constructor(private readonly include: (url: string) => boolean) {}

	/**
	 * How many functions and branches of the slice were new. With `commit` they
	 * count as reached from now on; without it only the branches' existence is kept.
	 */
	absorb(slice: ReadonlyArray<ScriptCoverage>, commit = true): number {
		if (!commit) {
			// Whatever the previous peek saw has had its chance to be found again.
			for (const mark of this.suspects) mark()
			this.suspects = []
		}
		let fresh = 0
		for (const script of slice) {
			if (script.url === "" || !this.include(script.url)) continue
			let state = this.scripts.get(script.url)
			if (state === undefined) this.scripts.set(script.url, (state = { scriptId: script.scriptId, functions: new Map() }))
			for (const fn of script.functions) {
				const [whole, ...blocks] = fn.ranges
				if (whole === undefined) continue
				let known = state.functions.get(whole.startOffset)
				if (known === undefined) state.functions.set(whole.startOffset, (known = { name: fn.functionName, offset: whole.startOffset, reached: false, branches: new Map() }))
				if (whole.count === 0) continue
				const entry = known
				if (!entry.reached) {
					if (commit) entry.reached = true
					else this.suspects.push(() => (entry.reached = true))
					fresh++
				}
				// V8 reports a branch only when its count differs from its parent's. So a
				// branch is taken in this slice when it is reported with a count, or when
				// it is known, not reported, and not inside a branch reported as zero.
				const zero = blocks.filter((b) => b.count === 0)
				for (const block of blocks) {
					const key = `${block.startOffset}:${block.endOffset}`
					if (!known.branches.has(key)) known.branches.set(key, false)
				}
				for (const [key, taken] of known.branches) {
					if (taken) continue
					const [start, end] = key.split(":").map(Number) as [number, number]
					if (zero.some((z) => z.startOffset <= start && end <= z.endOffset)) continue
					if (commit) entry.branches.set(key, true)
					else this.suspects.push(() => entry.branches.set(key, true))
					fresh++
				}
			}
		}
		return fresh
	}

	/**
	 * Makes the functions that had not run when collection started known, so the
	 * summary can name the ones no input reaches. A function that had already run
	 * (module setup) becomes known only if an input runs it again.
	 */
	register(snapshot: ReadonlyArray<ScriptCoverage>): void {
		// Committing changes nothing here: a function with a count of zero reaches nothing.
		this.absorb(snapshot.map((script) => ({ ...script, functions: script.functions.filter((fn) => fn.ranges[0]?.count === 0) })))
	}

	totals(): { readonly covered: number; readonly total: number } {
		let covered = 0
		let total = 0
		for (const script of this.scripts.values()) {
			for (const fn of script.functions.values()) {
				total += 1 + fn.branches.size
				if (fn.reached) covered++
				for (const taken of fn.branches.values()) if (taken) covered++
			}
		}
		return { covered, total }
	}
}

/**
 * The getter a bundler's module transform writes for each export, as vite's
 * does: `() => { try { return name } catch {} }`. Not the code under test.
 */
const EXPORT_GETTER_RE = /^\(\)\s*=>\s*\{\s*try\s*\{\s*return [\w$.]+\s*\}\s*catch\s*\{\s*\}\s*\}/

/** Offsets of a script's source turned into the lines of the file it was built from. */
const lineResolver = (source: string, fallbackFile: string): ((offset: number) => { readonly file: string; readonly line: number }) => {
	const lineStarts = [0]
	for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1)
	let map: SourceMap | undefined
	// The last one wins: a bundled dependency can carry the comment of its own build.
	const inline = [...source.matchAll(/^\/\/# sourceMappingURL=data:application\/json[^,]*;base64,([A-Za-z0-9+/=]+)\s*$/gm)].at(-1)
	if (inline !== undefined) {
		try {
			map = new SourceMap(JSON.parse(Buffer.from(inline[1]!, "base64").toString("utf8")))
		} catch {
			map = undefined
		}
	}
	return (offset) => {
		let low = 0
		let high = lineStarts.length - 1
		while (low < high) {
			const middle = (low + high + 1) >> 1
			if (lineStarts[middle]! <= offset) low = middle
			else high = middle - 1
		}
		const entry = map?.findEntry(low, offset - lineStarts[low]!) as { originalSource?: string; originalLine?: number } | undefined
		if (entry?.originalLine !== undefined) return { file: entry.originalSource ?? fallbackFile, line: entry.originalLine + 1 }
		return { file: fallbackFile, line: low + 1 }
	}
}

interface Collection {
	readonly session: Session
	/** Every function loaded when collection started, run or not. */
	readonly loaded: ReadonlyArray<ScriptCoverage>
	/** A script's source, for line numbers. Absent for a script the project loaded after collection started. */
	readonly sourceOf: (scriptId: string, url: string) => Promise<string | undefined>
}

/** On `globalThis`, not in a module variable: a test runner may evaluate this module more than once per process. */
const slot = globalThis as { [key: symbol]: Promise<Collection> | undefined }
const COLLECTION = Symbol.for("effect-prop/Coverage/collection")

const isDependency = (url: string): boolean => url.includes("/node_modules/")

/**
 * One collection per process, started by the first call and never stopped: the
 * profiler stays on until the process exits. V8 keeps its branch counters with
 * its debugging state, and only for code that was not already optimized when
 * collection started. So the sources, which only the debugger domain can read,
 * are read here, before collection starts: enabling that domain later slows
 * every call, and disabling it throws the counters away.
 */
const collection = (): Promise<Collection> =>
	(slot[COLLECTION] ??= (async () => {
		const session = new Session()
		try {
			session.connect()
			await session.post("Profiler.enable")
		} catch (cause) {
			throw new Error("effect-prop: Coverage needs the V8 inspector, which this runtime does not provide (Node only)", { cause })
		}
		// What a test runner evaluates is its transform of a file, not the file: only
		// V8 has the text the offsets point into. Enabling the domain lists every script.
		const scripts: Array<{ readonly scriptId: string; readonly url: string }> = []
		const listed = (message: { readonly params: { readonly scriptId: string; readonly url: string } }): void => void scripts.push(message.params)
		session.on("Debugger.scriptParsed", listed)
		await session.post("Debugger.enable")
		const sources = new Map<string, string>()
		for (const { scriptId, url } of scripts) {
			if (url.startsWith("file://") && !isDependency(url)) sources.set(scriptId, (await session.post("Debugger.getScriptSource", { scriptId })).scriptSource)
		}
		await session.post("Debugger.disable")
		session.off("Debugger.scriptParsed", listed)
		// Before collection starts: the only time V8 lists functions that have not run.
		const { result } = await session.post("Profiler.getBestEffortCoverage")
		await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true })
		return {
			session,
			loaded: result,
			// A dependency is loaded as it is on disk; anything else loaded late has no text to be had.
			sourceOf: async (scriptId, url) => sources.get(scriptId) ?? (isDependency(url) ? await readFile(new URL(url), "utf8").catch(() => undefined) : undefined),
		}
	})())

/**
 * Starts collecting now. A layer starts it by itself; call this first when the
 * code under test runs hot before the first coverage-guided check, because code
 * V8 has already optimized reports calls and no branches.
 */
export const start: Effect.Effect<void> = Effect.asVoid(Effect.promise(collection))

/**
 * Provides `Feedback` from V8 precise coverage of the scripts `include`
 * accepts. Each layer counts from nothing: what an earlier check reached is new
 * again to the next. Collection itself is process-wide and is not stopped when
 * the layer is released (see `collection`).
 */
export const layer = (options: CoverageOptions): Layer.Layer<never> =>
	Layer.effect(
		Feedback,
		Effect.gen(function* () {
			const { session, loaded, sourceOf } = yield* Effect.promise(collection)
			const tracker = new Tracker(options.include)
			tracker.register(loaded)
			const take = (commit: boolean): Effect.Effect<number> =>
				Effect.promise(() => session.post("Profiler.takePreciseCoverage")).pipe(Effect.map(({ result }) => tracker.absorb(result, commit)))

			const summary = Effect.promise(async () => {
				const files: Array<FileSummary> = []
				for (const [url, script] of tracker.scripts) {
					const source = await sourceOf(script.scriptId, url)
					const resolve = source === undefined ? undefined : lineResolver(source, relativePath(url))
					let covered = 0
					let total = 0
					const unreached: Array<string> = []
					for (const fn of script.functions.values()) {
						if (source !== undefined && EXPORT_GETTER_RE.test(source.slice(fn.offset, fn.offset + 200))) continue
						total += 1 + fn.branches.size
						if (fn.reached) covered++
						else unreached.push(`${fn.name === "" ? "(anonymous)" : fn.name}${resolve === undefined ? "" : `:${resolve(fn.offset).line}`}`)
						for (const taken of fn.branches.values()) if (taken) covered++
					}
					files.push({ file: relativePath(url), covered, total, unreached })
				}
				return {
					kind: "v8 coverage",
					covered: files.reduce((sum, file) => sum + file.covered, 0),
					total: files.reduce((sum, file) => sum + file.total, 0),
					files: files.sort((a, b) => a.file.localeCompare(b.file)),
				}
			})

			const begin = Effect.asVoid(Effect.promise(() => session.post("Profiler.takePreciseCoverage")))
			const service: FeedbackService = { begin, novelty: take(true), peek: take(false), summary }
			return service
		}),
	)

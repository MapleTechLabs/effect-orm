// Properties as vitest tests.
//
//   prop("reverse twice is the identity", Gen.array(Gen.int()), (xs) => …)
//
// A failing property fails the test with the report: every distinct failure,
// its shrunk input and the `PROP_REPLAY` value that reruns it. Failures are
// remembered under `.prop/regressions` and replayed first on the next run.
import { Config, Effect, Layer, type Scope } from "effect"
import { expect, it } from "vitest"
import type * as Gen from "./Gen"
import { relativePath } from "./internal"
import * as Prop from "./Prop"
import { layer as layerRegressions } from "./RegressionsNode"

export interface PropOptions<A, E, R> extends Omit<Prop.CheckOptions<A, E, R>, "name"> {
	/** Where failures are remembered, or `false` to remember none. Default `.prop/regressions`. */
	readonly regressions?: string | false | undefined
	/** The vitest timeout of the whole property, in milliseconds. */
	readonly testTimeout?: number | undefined
	/**
	 * Provides what the property requires, and what the check reads (a
	 * `Feedback`, a tracer). Built once for the whole property, not per input.
	 */
	readonly layer?: Layer.Layer<R, unknown> | undefined
}

type Provided<R> = Exclude<R, Scope.Scope>
/** A property that requires services must be given the layer that provides them. */
type Options<A, E, R> = [Provided<R>] extends [never]
	? [options?: PropOptions<A, E, never>]
	: [options: PropOptions<A, E, Provided<R>> & { readonly layer: Layer.Layer<Provided<R>, unknown> }]

const verbose = Config.Boolean("PROP_VERBOSE").pipe(Config.withDefault(false))

/** The type parameters erased: `define` has checked the property against its generator and layer. */
type Erased = PropOptions<any, any, any>

const execute = async (gen: Gen.Gen<any>, property: Prop.Property<any, any, any>, options: Erased | undefined, signal: AbortSignal): Promise<void> => {
	const { currentTestName, testPath } = expect.getState()
	// With the file, as the repository sees it: two files may each have a property of the same name.
	const name = `${testPath === undefined ? "" : `${relativePath(testPath)} > `}${currentTestName ?? "property"}`
	const regressions = options?.regressions ?? ".prop/regressions"
	const checked = Effect.gen(function* () {
		const report = yield* Prop.check(gen, property, yield* Prop.fromEnvironment({ ...options, name }))
		// To stdout itself: vitest holds back the console of a passing test.
		if (yield* Effect.orDie(verbose)) process.stdout.write(`${Prop.formatReport(report, { coverage: true })}\n`)
		return report
	})
	// The caller's layer last, so a `Regressions` of its own wins.
	const layers = Layer.mergeAll(regressions === false ? Layer.empty : layerRegressions(regressions), options?.layer ?? Layer.empty)
	// The signal ends the search when vitest gives up on the test; a search left
	// running would share V8's coverage counters with the next property.
	const report = await Effect.runPromise(checked.pipe(Effect.provide(layers)) as Effect.Effect<Prop.Report<unknown, unknown>>, { signal })
	if (!Prop.passed(report)) throw new Error(Prop.formatReport(report))
}

const define =
	(test: typeof it | typeof it.only | typeof it.skip) =>
	<A, E = never, R = never>(name: string, gen: Gen.Gen<A>, property: Prop.Property<A, E, R>, ...[options]: Options<A, E, R>): void => {
		test(name, ({ signal }) => execute(gen, property, options as Erased | undefined, signal), options?.testTimeout)
	}

/** A vitest test that checks a property. */
export const prop: ReturnType<typeof define> & { readonly only: ReturnType<typeof define>; readonly skip: ReturnType<typeof define> } = Object.assign(
	define(it),
	{ only: define(it.only), skip: define(it.skip) },
)

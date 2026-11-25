// What `prop` must refuse to compile. Checked by `tsc`; never run.
import { Context, Effect, Layer } from "effect"
import { Gen } from "../src/index"
import { prop } from "../src/vitest"

class Limit extends Context.Service<Limit, { readonly max: number }>()("test/Limit") {}

const needsLimit = (n: number) =>
	Effect.gen(function* () {
		return n <= (yield* Limit).max
	})

export const typeErrors = (): void => {
	// @ts-expect-error a property that requires a service needs the layer that provides it
	prop("no layer", Gen.int(), needsLimit)
	// @ts-expect-error and options without one are not enough
	prop("no layer", Gen.int(), needsLimit, { runs: 10 })
	prop("layer", Gen.int(), needsLimit, { layer: Layer.succeed(Limit, { max: 1 }) })
	// @ts-expect-error the property must accept what the generator builds
	prop("wrong input", Gen.string(), (n: number) => n > 0)
	// A property that requires nothing may still be given a layer the check reads.
	prop("extra layer", Gen.int(), (n) => n === n, { layer: Layer.empty, format: (n) => n.toFixed(0), examples: [1] })
}

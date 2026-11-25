// Spans as search feedback: for runtimes without V8 coverage (Bun, browsers),
// and for code whose interesting paths are already traced.
//
// The layer wraps the current tracer and records every parent → child pair of
// span names it is asked to open. An input is novel when it opens a pair no
// earlier input did. Far coarser than code coverage: it sees only what the
// code under test wraps in a span.
import { Context, Effect, Layer, Option, Tracer } from "effect"
import { Feedback, type FeedbackService } from "./Feedback"

/** Provides `Feedback` from the spans the code under test opens, and the tracer that observes them. */
export const layer: Layer.Layer<never> = Layer.effectContext(
	Effect.gen(function* () {
		const inner = yield* Tracer.Tracer
		const seen = new Set<string>()
		const pending = new Set<string>()
		let peeked: ReadonlyArray<string> = []
		const tracer = Tracer.make({
			span(options) {
				const parent = Option.getOrUndefined(options.parent)
				// The checker's own spans are not the code under test.
				if (!options.name.startsWith("effect-prop.")) {
					const from = parent !== undefined && parent._tag === "Span" && !parent.name.startsWith("effect-prop.") ? parent.name : ""
					const edge = `${from} > ${options.name}`
					if (!seen.has(edge)) pending.add(edge)
				}
				return inner.span(options)
			},
			context: inner.context,
		})
		const service: FeedbackService = {
			begin: Effect.sync(() => {
				seen.clear()
				pending.clear()
				peeked = []
			}),
			novelty: Effect.sync(() => {
				const count = pending.size
				for (const edge of pending) seen.add(edge)
				pending.clear()
				return count
			}),
			peek: Effect.sync(() => {
				for (const edge of peeked) seen.add(edge)
				peeked = [...pending].filter((edge) => !seen.has(edge))
				pending.clear()
				return peeked.length
			}),
			summary: Effect.sync(() => ({ kind: "span edges", covered: seen.size, total: seen.size, files: [] })),
		}
		return Context.make(Feedback, service).pipe(Context.add(Tracer.Tracer, tracer))
	}),
)

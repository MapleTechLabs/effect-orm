// State of one compile, kept in the context of the fiber that runs it.
//
// Identifiers, literals and failures are written deep inside expression code
// that has no argument to carry the compile's state. A compile installs that
// state in its fiber's context for the length of a synchronous body instead,
// and the code below reads it back from the same fiber. Two compiles in two
// fibers never see each other's state, also when a fiber yields. There is no
// module-level state: outside any fiber, a value is installed by running the
// body in a fiber of its own.

import { Context, Effect, Fiber } from "effect"

/** A value installed for a synchronous body, in the context of the fiber that runs it. */
export interface FiberLocal<A> {
	/** The value installed by the enclosing body in this fiber, or the reference's default. */
	readonly get: () => A
	/** Run `body` with `value` installed. The previous value comes back after, also when `body` throws. */
	readonly with: <B>(value: A, body: () => B) => B
}

export const fiberLocal = <A>(ref: Context.Reference<A>): FiberLocal<A> => {
	const get = (): A => {
		const fiber = Fiber.getCurrent()
		return fiber === undefined ? ref.defaultValue() : fiber.getRef(ref)
	}
	const with_ = <B>(value: A, body: () => B): B => {
		const fiber = Fiber.getCurrent()
		// A throw from `body` is the caller's: `runSync` gives it back as it was thrown.
		if (fiber === undefined) return Effect.runSync(Effect.sync(() => with_(value, body)))
		const previous = fiber.context
		fiber.setContext(Context.add(previous, ref, value))
		try {
			return body()
		} finally {
			fiber.setContext(previous)
		}
	}
	return { get, with: with_ }
}

/**
 * Run `effect` at once, in the context of the fiber that calls this, if any.
 * For the unsafe compile entry points: a compile nested in another compile's
 * body keeps the enclosing compile's state, and one called from an Effect sees
 * what that Effect provided.
 */
export const runSyncHere = <A, E>(effect: Effect.Effect<A, E>): A => {
	const fiber = Fiber.getCurrent()
	return fiber === undefined ? Effect.runSync(effect) : Effect.runSyncWith(fiber.context)(effect)
}

// Stateful properties: a sequence of commands run against a real system and a
// model of it.
//
// The sequence is generated against the model, one command at a time, so each
// command is valid for the state the ones before it produce (no "pop" on an
// empty stack unless you generate one). Each command is a span: the shrinker
// removes commands, and the generator rebuilds the rest against the new states.
import { Effect, Schema } from "effect"
import * as Gen from "./Gen"
import * as Prop from "./Prop"

export interface Command<Model, System, E = never, R = never> {
	readonly name: string
	/** The model after this command. */
	readonly next: (model: Model) => Model
	/** Runs the command on the system and checks the outcome against the model as it was before. */
	readonly run: (system: System, model: Model) => Effect.Effect<void | boolean, E, R>
}

export interface CommandsOptions<Model, C> {
	readonly initial: Model
	/** The commands that make sense in a state. */
	readonly command: (model: Model) => Gen.Gen<C>
	/** Default 50. */
	readonly maxLength?: number | undefined
}

/** A sequence of commands, each generated for the model state the earlier ones lead to. */
export const commands = <Model, C extends Command<Model, any, any, any>>(options: CommandsOptions<Model, C>): Gen.Gen<Array<C>> => {
	const maxLength = options.maxLength ?? 50
	return Gen.make((source) => {
		let model = options.initial
		return Gen.repeat(source, "command", 0, maxLength, () => {
			const command = options.command(model).run(source)
			model = command.next(model)
			return command
		})
	})
}

/** A command reported that the system and the model disagree. `step` counts from 0. */
export class CommandFailed extends Schema.TaggedError<CommandFailed>()("effect-prop/CommandFailed", {
	message: Schema.String,
	step: Schema.Number,
	command: Schema.String,
}) {}

/**
 * Runs the commands in order on `system`, advancing the model alongside. Fails
 * at the first command that fails or returns `false`; that failure is grouped
 * by the command's name. What the property checks after the run groups by itself.
 */
export const run = <Model, System, E, R>(
	initial: Model,
	system: System,
	sequence: ReadonlyArray<Command<Model, System, E, R>>,
): Effect.Effect<void, E | CommandFailed, R> =>
	Effect.gen(function* () {
		let model = initial
		for (const [step, command] of sequence.entries()) {
			yield* Prop.label(command.name)
			const named = Prop.signature(`command ${command.name}`)
			const held = yield* Effect.tapCause(command.run(system, model), () => named)
			if (held === false) {
				yield* named
				const message = `command ${step + 1} (${command.name}) returned false: the system and the model disagree`
				return yield* new CommandFailed({ message, step, command: command.name })
			}
			model = command.next(model)
		}
	})

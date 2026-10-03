import { Schema } from "effect"

/** A statement the server rejected, or a connection failure while running one. */
export class MigrateSqlError extends Schema.TaggedError<MigrateSqlError>()("@maple-dev/effect-orm/MigrateSqlError", {
	message: Schema.String,
	sql: Schema.String,
	cause: Schema.Defect(),
}) {}

/** A migration file or snapshot that does not decode, or a migration set that cannot be ordered. */
export class MigrateSourceError extends Schema.TaggedError<MigrateSourceError>()(
	"@maple-dev/effect-orm/MigrateSourceError",
	{ migration: Schema.String, message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/** An applied migration whose file has changed since it ran. */
export class MigrateHashMismatch extends Schema.TaggedError<MigrateHashMismatch>()(
	"@maple-dev/effect-orm/MigrateHashMismatch",
	{ migration: Schema.String, appliedHash: Schema.String, currentHash: Schema.String, message: Schema.String },
) {}

/** Another run holds the migration lease. */
export class MigrateLeaseHeld extends Schema.TaggedError<MigrateLeaseHeld>()("@maple-dev/effect-orm/MigrateLeaseHeld", {
	owner: Schema.String,
	expiresAt: Schema.String,
	message: Schema.String,
}) {}

/** A statement failed partway through a migration. Rerunning resumes at this step. */
export class MigrateStepFailed extends Schema.TaggedError<MigrateStepFailed>()("@maple-dev/effect-orm/MigrateStepFailed", {
	migration: Schema.String,
	step: Schema.String,
	sql: Schema.String,
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

/** A statement a partial migration already ran has different SQL now. */
export class MigrateStepChanged extends Schema.TaggedError<MigrateStepChanged>()("@maple-dev/effect-orm/MigrateStepChanged", {
	migration: Schema.String,
	step: Schema.String,
	message: Schema.String,
}) {}

/**
 * A statement started and never reported back: it may or may not have run.
 * Check the database, then record what happened with `resolveStep`.
 */
export class MigrateStepUncertain extends Schema.TaggedError<MigrateStepUncertain>()(
	"@maple-dev/effect-orm/MigrateStepUncertain",
	{ migration: Schema.String, step: Schema.String, sql: Schema.String, message: Schema.String },
) {}

export type MigrateError = MigrateSqlError | MigrateSourceError | MigrateHashMismatch | MigrateLeaseHeld | MigrateStepChanged | MigrateStepFailed | MigrateStepUncertain

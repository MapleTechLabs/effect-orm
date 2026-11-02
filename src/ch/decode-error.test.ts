import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Schema } from "effect"
import { inspect } from "node:util"
import { compileCHUnsafe, rawCompiledQuery } from "./compile"
import { formatDecodeError } from "./decode-error"
import * as CH from "./index"

// A wire value that must never reach a log line.
const SECRET = "+1-555-0100"

const phoneQuery = () =>
	rawCompiledQuery<{ readonly phone: number }>({
		reason: "test-fixture",
		justification: "Synthetic SQL asserting decode-error formatting, not a product query.",
		tenantScope: "single-tenant",
		sql: "SELECT phone FROM contacts",
		rowSchema: Schema.Struct({ phone: Schema.Number }),
	})

describe("CompiledQueryDecodeError", () => {
	it.effect("names the column path and the expected type in its message", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(phoneQuery().decodeRows([{ phone: SECRET }]))

			expect(error.message).toBe('Compiled query row 0 did not match its declared output schema: at ["phone"] expected number')
			expect(error.column).toBe("phone")
			expect(error.issues).toEqual([{ path: ["phone"], kind: "InvalidType", expected: "number" }])
		}),
	)

	// The ClickHouse DateTime codec quotes the text it could not parse, so the
	// raw Schema error holds the value. None of the ways to log the error may.
	it.effect("keeps the row value out of message, toString, JSON, inspect and Cause.pretty", () =>
		Effect.gen(function* () {
			const compiled = rawCompiledQuery<{ readonly at: unknown }>({
				reason: "test-fixture",
				justification: "Synthetic SQL asserting decode-error formatting, not a product query.",
				tenantScope: "single-tenant",
				sql: "SELECT at FROM contacts",
				rowSchema: Schema.Struct({ at: CH.dateTime.schema }),
			})
			const error = yield* Effect.flip(compiled.decodeRows([{ at: SECRET }]))

			expect(error.schemaError?.message).toContain(SECRET)
			for (const printed of [
				error.message,
				String(error),
				JSON.stringify(error),
				inspect(error, { depth: 20 }),
				Cause.pretty(Cause.fail(error)),
				formatDecodeError(error),
			]) {
				expect(printed).not.toContain(SECRET)
			}
			expect(error.issues).toEqual([{ path: ["at"], kind: "Encoding", expected: "DateTime.Utc" }])
		}),
	)

	it.effect("carries the dialect and the table of the query", () =>
		Effect.gen(function* () {
			const contacts = CH.table("contacts", { OrgId: CH.string, phone: CH.uint32 }, { tenantColumn: "OrgId" })
			const compiled = compileCHUnsafe(
				CH.from(contacts)
					.select(($) => ({ phone: $.phone }))
					.where(($) => [$.OrgId.eq("org")]),
				{},
			)
			const error = yield* Effect.flip(compiled.decodeRows([{ phone: SECRET }]))

			expect(error.dialect).toBe("clickhouse")
			expect(error.collection).toBe("contacts")
			expect(formatDecodeError(error)).toBe(
				`CompiledQueryDecodeError (clickhouse, contacts): row 0: at ["phone"] expected a finite number`,
			)
		}),
	)

	it.effect("prints the raw Schema error only when verbose is set", () =>
		Effect.gen(function* () {
			const compiled = rawCompiledQuery<{ readonly at: unknown }>({
				reason: "test-fixture",
				justification: "Synthetic SQL asserting decode-error formatting, not a product query.",
				tenantScope: "single-tenant",
				sql: "SELECT at FROM contacts",
				rowSchema: Schema.Struct({ at: CH.dateTime.schema }),
			})
			const error = yield* Effect.flip(compiled.decodeRows([{ at: SECRET }]))

			expect(formatDecodeError(error)).not.toContain(SECRET)
			expect(formatDecodeError(error, { verbose: true })).toContain(SECRET)
		}),
	)
})

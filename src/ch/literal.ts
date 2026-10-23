// Values → ClickHouse literals
//
// The encode half of the column types. A column type is a `Schema`, so a value
// compared against that column can be encoded through it — turning a
// `DateTime.Utc` into `'2026-01-01 00:00:00'`, a boolean into `1` — and the
// result is a wire value this module writes as ClickHouse syntax.
//
// Everything that reaches SQL as a literal goes through `sqlLiteral`, and it is
// deliberately total: a value it cannot represent raises rather than falling
// back to `String(value)`. That fallback is what emitted `Attrs = [object
// Object]` and `Tags = a,b` — SQL that is either an error or, worse, a bare
// identifier that happens to parse.

import { activeLiteralBinder } from "../sql/literal-binder"
import { Result, Schema } from "effect"
import { QueryBuilderError } from "./errors"
import { quoteClickHouseString } from "../sql/sql-fragment"
import { activeSqlSyntax } from "../sql/sql-syntax"
import type { CHType } from "./types"
import { fail } from "./failure"

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" &&
	value !== null &&
	(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

const describe = (value: unknown): string => {
	if (value === null) return "null"
	if (value === undefined) return "undefined"
	if (typeof value === "function") return "a function"
	if (typeof value === "symbol") return "a symbol"
	if (typeof value === "number" || typeof value === "boolean") return `${value}`
	if (value instanceof Date) return "a Date"
	if (Array.isArray(value)) return "an array"
	if (typeof value === "object") return "an object"
	return `${typeof value} ${JSON.stringify(value) ?? String(value)}`
}

/** Schema failures are multi-line, and one line reads better inside a sentence. */
const oneLine = (failure: unknown): string =>
	String(failure)
		.replace(/^SchemaError:?\s*/, "")
		.replace(/\s*\n\s*/g, "; ")
		.trim()

/** Below the smallest normal double: a value ClickHouse's SQL parser cannot read back. */
export const isSubnormal = (value: number): boolean => value !== 0 && Math.abs(value) < 2.2250738585072014e-308

/**
 * A finite double as digits that read back as exactly that double.
 *
 * `String(value)` is the shortest decimal that rounds to it, which a float
 * parser rounds back — but a whole number past 2^53 prints as an integer
 * (`44812297868494010`), and an integer literal is parsed exactly, as a value
 * the double is not (it is …008). Below 2^64 the double's own integer value is
 * written instead; above, `String` already uses an exponent.
 */
export const numberText = (value: number): string =>
	Number.isInteger(value) && !Number.isSafeInteger(value) && Math.abs(value) < 2 ** 64 ? BigInt(value).toString() : String(value)

/**
 * A subnormal double as ClickHouse SQL. Written as a decimal (`5e-324`) it is a
 * syntax error, and parsed from text (`toFloat64('5e-324')`) it flushes to 0, so
 * it is rebuilt from its IEEE bits, which is exact.
 */
const subnormalLiteral = (value: number): string => {
	const view = new DataView(new ArrayBuffer(8))
	view.setFloat64(0, value)
	return `reinterpretAsFloat64(toUInt64(${view.getBigUint64(0)}))`
}

/**
 * A wire value as ClickHouse literal syntax.
 *
 * The input is what a column type's schema *encodes to* — a string, a number, a
 * boolean, null, or arrays and records of those — not an arbitrary JS value.
 */
export function sqlLiteral(value: unknown, context: string): string {
	if (value === null) return "NULL"
	if (typeof value === "string") return quoteClickHouseString(value)
	if (typeof value === "bigint") return String(value)
	if (typeof value === "boolean") return value ? "1" : "0"

	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			return fail(new QueryBuilderError({
				code: "InvalidLiteral",
				message: `${context}: ${value} has no ClickHouse literal`,
			}), "NULL")
		}
		return isSubnormal(value) ? subnormalLiteral(value) : numberText(value)
	}

	if (Array.isArray(value)) {
		return `[${value.map((element) => sqlLiteral(element, context)).join(", ")}]`
	}

	// ClickHouse has no object literal syntax: a Map is built by `map(k, v, …)`.
	if (isPlainObject(value)) {
		const pairs = Object.entries(value).flatMap(([key, entry]) => [
			sqlLiteral(key, context),
			sqlLiteral(entry, context),
		])
		return `map(${pairs.join(", ")})`
	}

	return fail(new QueryBuilderError({
		code: "InvalidLiteral",
		message: `${context}: cannot write ${describe(value)} as a ClickHouse literal`,
	}), "NULL")
}

/**
 * Encode a value through a schema, then write it as a literal.
 *
 * The schema is the contract in both directions, so a value of the wrong shape
 * fails here — while building the SQL — instead of becoming part of it.
 */
export function encodeLiteral<A>(schema: Schema.Codec<A, any>, value: unknown, context: string): string {
	const wire = encodeValue(schema, value, context)
	const bind = activeLiteralBinder()
	return bind !== undefined ? bind(wire) : (activeSqlSyntax()?.literal ?? sqlLiteral)(wire, context)
}

/**
 * Encode a value through a schema to its wire form, without writing SQL.
 *
 * The half of {@link encodeLiteral} a dialect that binds params needs: the
 * driver sends the wire value itself, so there is no literal to write.
 */
export function encodeValue<A>(schema: Schema.Codec<A, any>, value: unknown, context: string): unknown {
	const encoded = Schema.encodeUnknownResult(schema)(value)
	if (Result.isFailure(encoded)) {
		return fail(new QueryBuilderError({
			code: "InvalidLiteral",
			message: `${context}: ${describe(value)} is not a valid value — ${oneLine(encoded.failure)}`,
		}), null)
	}
	return encoded.success
}

/** `encodeLiteral` against a column type, naming the column in any failure. */
export const encodeColumnLiteral = (
	columnType: CHType<string, any, any>,
	value: unknown,
	column: string,
): string => encodeLiteral(columnType.literalSchema, value, `column ${column}`)

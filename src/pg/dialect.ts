// The Postgres dialect.

import { DateTime, Schema } from "effect"
import type { Dialect } from "../ch/dialect"
import { QueryBuilderError } from "../ch/errors"
import { PARAM_MARKER_PREFIX } from "../ch/param"
import { PgTimestampLiteral, timestampLiteral } from "./types"

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`

/**
 * A string literal. Plain `'...'` with quotes doubled, which reads backslashes
 * as text (`standard_conforming_strings`, the default since Postgres 9.1). A
 * value that contains the param marker is written as an `E'...'` string instead,
 * the one form where the marker can be hex-escaped (`\x5F` is `_`).
 */
const quoteString = (value: string): string => {
	if (value.includes("\0")) {
		throw new QueryBuilderError({
			code: "InvalidLiteral",
			message: "a string literal: Postgres text cannot contain a NUL character",
		})
	}
	if (!value.includes(PARAM_MARKER_PREFIX)) return `'${value.replace(/'/g, "''")}'`
	const escaped = value
		.replace(/\\/g, "\\\\")
		.replace(/'/g, "''")
		.replace(/__PARAM_/g, "\\x5F_PARAM_")
	return `E'${escaped}'`
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" &&
	value !== null &&
	(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

/** An encoded wire value as a Postgres literal. */
const literal = (value: unknown, context: string): string => {
	if (value === null) return "NULL"
	if (typeof value === "string") return quoteString(value)
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE"
	if (typeof value === "bigint") return String(value)
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new QueryBuilderError({ code: "InvalidLiteral", message: `${context}: ${value} has no Postgres literal` })
		}
		return String(value)
	}
	// `ARRAY[]` needs a cast to say its element type; the untyped `'{}'` takes
	// the type of whatever it is compared against.
	if (Array.isArray(value)) {
		return value.length === 0 ? "'{}'" : `ARRAY[${value.map((element) => literal(element, context)).join(", ")}]`
	}
	// A record reaches here from a jsonb codec that did not stringify it.
	if (isPlainObject(value)) return quoteString(JSON.stringify(value))
	throw new QueryBuilderError({
		code: "InvalidLiteral",
		message: `${context}: cannot write ${typeof value} as a Postgres literal`,
	})
}

/** `param.dateTimeSeconds`: the same instant, floored to whole seconds. */
const timestampSeconds = timestampLiteral((epochMillis) => new Date(Math.floor(epochMillis / 1000) * 1000).toISOString())

/**
 * Casts for the param kinds whose Postgres type is unambiguous. Postgres types
 * an untyped `$n` from its context, so a float compared with an int8 column
 * binds as int8 and rejects `19.5`, and a param in a select list binds as text.
 * `string` and `int` stay uncast: a cast would stop them comparing with an enum
 * or int4 column.
 */
const placeholderCasts: Readonly<Record<string, string>> = {
	float: "float8",
	bool: "boolean",
	dateTime: "timestamptz",
	dateTimeSeconds: "timestamptz",
}

/**
 * Postgres: double-quoted identifiers, standard string literals, and params
 * bound to `$1`, `$2`, … and returned in `CompiledQuery.parameters`.
 *
 * Portable param kinds encode for Postgres: `param.bool` binds a boolean
 * rather than ClickHouse's `1`/`0`, and `param.dateTime` an ISO-8601 instant
 * rather than a zoneless string a session time zone could reinterpret.
 */
export const postgresDialect: Dialect = {
	name: "postgres",
	quoteIdent,
	quoteString,
	literal,
	dateTimeLiteral: (value) => `TIMESTAMPTZ ${quoteString(DateTime.formatIso(value))}`,
	params: {
		_tag: "bind",
		placeholder: (index, kind) => (Object.hasOwn(placeholderCasts, kind) ? `$${index}::${placeholderCasts[kind]}` : `$${index}`),
		reuse: true,
		// The wire protocol counts parameters in an Int16.
		maxParameters: 65535,
	},
	clauses: { format: false, derivedTableAlias: true, groupByAlias: false, parenthesizeUnionBranches: true },
	paramCodecs: {
		bool: Schema.Boolean,
		dateTime: PgTimestampLiteral,
		dateTimeSeconds: timestampSeconds,
	},
	transactions: {
		support: "full",
		savepoints: true,
		isolationLevels: ["read committed", "repeatable read", "serializable"],
		accessModes: true,
		deferrable: true,
		setTransaction: (settings) => {
			const modes = [
				settings.isolationLevel === undefined ? undefined : `ISOLATION LEVEL ${settings.isolationLevel.toUpperCase()}`,
				settings.accessMode?.toUpperCase(),
				settings.deferrable === undefined ? undefined : settings.deferrable ? "DEFERRABLE" : "NOT DEFERRABLE",
			].filter((mode) => mode !== undefined)
			return modes.length === 0 ? undefined : `SET TRANSACTION ${modes.join(", ")}`
		},
	},
}

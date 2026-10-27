// BOUNDARY: This module turns a Schema parse failure of a wire row into an
// error that is safe to log.
//
// A row is user data: a phone number, an email, a token. The Schema error that
// a failed decode produces can quote that data — a codec's own message
// (`"<value>" is not a ClickHouse DateTime`), a filter that returns a message
// built from its input, `reportInput`. `Cause.pretty` and `util.inspect` print
// an `Error.cause` chain, so carrying the Schema error as `cause` put the value
// in every log line that printed the failure.
//
// So the error keeps only what the schema says, never what the row held: the
// path of each issue, its kind, and the expected type read from the schema
// AST. The Schema error itself stays on the error as a non-enumerable property,
// out of `toString`, `JSON.stringify`, `inspect` and `Cause.pretty`.

import { Schema, SchemaIssue } from "effect"

/** One decode issue: where it is in the row and what the schema expected there. */
export const DecodeIssue = Schema.Struct({
	/** The path from the row to the value, as Schema reports it. The first segment is the column alias. */
	path: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
	/** The Schema issue tag: `InvalidType`, `MissingKey`, `Filter`, `Encoding`, … */
	kind: Schema.String,
	/** What the schema expected, from the schema AST. Absent when the schema does not say. */
	expected: Schema.optional(Schema.String),
})
export type DecodeIssue = typeof DecodeIssue.Type

export class CompiledQueryDecodeError extends Schema.TaggedError<CompiledQueryDecodeError>()(
	"@maple-dev/effect-orm/CompiledQueryDecodeError",
	{
		message: Schema.String,
		rowIndex: Schema.Number,
		/** The dialect the query was compiled for or ran on, when known. */
		dialect: Schema.optional(Schema.String),
		/** The table the statement reads, when it has a single one. */
		collection: Schema.optional(Schema.String),
		/** The column alias of the first issue. */
		column: Schema.optional(Schema.String),
		issues: Schema.Array(DecodeIssue),
	},
) {
	/**
	 * The Schema error the decode failed with. It can hold row values, so it is
	 * not enumerable and is not the error's `cause`: logging the error does not
	 * print it. Read it here, or with `formatDecodeError(error, { verbose: true })`.
	 */
	declare readonly schemaError: Schema.SchemaError | undefined
}

/** Options for {@link formatDecodeError}. */
export interface FormatDecodeErrorOptions {
	/**
	 * Append the raw Schema error message. It can contain row values: use it for
	 * local debugging, not for shared logs.
	 */
	readonly verbose?: boolean
}

/**
 * A one-line summary of a decode failure: dialect, table, row index, and the
 * path and expected type of each issue. It holds no row values unless
 * `verbose` is set.
 */
export const formatDecodeError = (error: CompiledQueryDecodeError, options?: FormatDecodeErrorOptions): string => {
	const context = [error.dialect, error.collection].filter((part) => part !== undefined)
	const head = `CompiledQueryDecodeError${context.length > 0 ? ` (${context.join(", ")})` : ""}: row ${error.rowIndex}`
	const issues = error.issues.length > 0 ? `: ${describeIssues(error.issues)}` : ""
	const raw = options?.verbose === true && error.schemaError !== undefined ? `\n${error.schemaError.message}` : ""
	return `${head}${issues}${raw}`
}

/** @internal Build the error from a failed row decode. */
export const decodeErrorFromCause = (input: {
	readonly prefix: string
	readonly rowIndex: number
	readonly cause: unknown
	readonly dialect?: string | undefined
	readonly collection?: string | undefined
}): CompiledQueryDecodeError => {
	const schemaError = Schema.isSchemaError(input.cause) ? input.cause : undefined
	const issues = schemaError === undefined ? [] : collectIssues(schemaError.issue, [], undefined)
	const first = issues[0]?.path[0]
	const error = new CompiledQueryDecodeError({
		message: issues.length > 0 ? `${input.prefix}: ${describeIssues(issues)}` : input.prefix,
		rowIndex: input.rowIndex,
		...(input.dialect !== undefined ? { dialect: input.dialect } : undefined),
		...(input.collection !== undefined ? { collection: input.collection } : undefined),
		...(typeof first === "string" ? { column: first } : undefined),
		issues,
	})
	Object.defineProperty(error, "schemaError", { value: schemaError, enumerable: false })
	return error
}

const describeIssues = (issues: ReadonlyArray<DecodeIssue>): string =>
	issues
		.map((issue) => {
			const at = issue.path.length > 0 ? `at ${formatPath(issue.path)} ` : ""
			return issue.expected !== undefined ? `${at}expected ${issue.expected}` : `${at}${issue.kind}`
		})
		.join("; ")

// Path segments are schema keys (column aliases, field names, array indexes), not values.
const formatPath = (path: ReadonlyArray<string | number>): string =>
	`[${path.map((segment) => (typeof segment === "number" ? String(segment) : JSON.stringify(segment))).join("][")}]`

const pathSegment = (key: PropertyKey): string | number => (typeof key === "symbol" ? String(key) : key)

/**
 * Walk the issue tree to its leaves. Reads only the tree's shape and the schema
 * AST: never `input`, never a message an issue carries.
 */
const collectIssues = (
	issue: SchemaIssue.Issue,
	path: ReadonlyArray<string | number>,
	enclosing: SchemaIssue.Issue | undefined,
): ReadonlyArray<DecodeIssue> => {
	switch (issue._tag) {
		case "Pointer":
			return collectIssues(issue.issue, [...path, ...issue.path.map(pathSegment)], undefined)
		case "Composite":
			return issue.issues.flatMap((child) => collectIssues(child, path, issue))
		case "AnyOf":
			return issue.issues.length > 0
				? issue.issues.flatMap((child) => collectIssues(child, path, issue))
				: [leaf(path, issue._tag, expectedOf(issue.ast))]
		case "Encoding":
			// A transformation failed. Its own message can quote the value; the AST
			// it decodes to says what was expected.
			return [leaf(path, issue._tag, expectedOf(issue.ast))]
		case "Filter": {
			const annotated = issue.filter.annotations?.expected
			const expected =
				typeof annotated === "string"
					? annotated
					: enclosing !== undefined && "ast" in enclosing
						? expectedOf(enclosing.ast)
						: undefined
			return [leaf(path, issue._tag, expected)]
		}
		case "InvalidType":
			return [leaf(path, issue._tag, expectedOf(issue.ast))]
		case "OneOf":
			return [leaf(path, issue._tag, expectedOf(issue.ast))]
		case "MissingKey":
		case "UnexpectedKey":
		case "InvalidValue":
		case "Forbidden":
			return [leaf(path, issue._tag, undefined)]
	}
}

const leaf = (path: ReadonlyArray<string | number>, kind: string, expected: string | undefined): DecodeIssue =>
	expected === undefined ? { path, kind } : { path, kind, expected }

/**
 * What a schema AST expects, as Schema's own formatter words it. The issue is
 * built here with no input, so the text comes from the AST alone.
 */
const expectedOf = (ast: SchemaIssue.InvalidType["ast"]): string | undefined => {
	const text = SchemaIssue.defaultLeafHook(new SchemaIssue.InvalidType(ast))
	return text.startsWith("Expected ") ? text.slice("Expected ".length) : text
}

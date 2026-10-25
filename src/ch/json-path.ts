// Typed JSON paths, the part no dialect changes.
//
// A path is a list of keys: a string steps into an object, a number into an
// array. Its type comes from the column's TypeScript type (`JsonPath`,
// `JsonPathValue`) and its decoder from the column's Schema (`jsonPathSchema`),
// so `jsonPath($.payload, "profile", "city")` is an `Expr<string | null>` that
// validates what it reads. Only the SQL differs per dialect: Postgres writes
// `x -> 'profile' -> 'city'` (src/pg/functions.ts); a SQLite or MySQL catalog
// would write `json_extract(x, '$.profile.city')` from the same keys and reuse
// everything here.

import { Schema, SchemaAST } from "effect"

/** One step into a JSON document: an object key or an array index. */
export type JsonKey = string | number

/** Counts down the depth `JsonPath` spells out, so a recursive type ends. */
type Prev = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8]

/** The keys one step into a value of type `A`: its field names, or `number` for an array. */
export type JsonKeyOf<A> = unknown extends A
	? JsonKey
	: A extends ReadonlyArray<any>
		? number
		: A extends object
			? Extract<keyof A, string>
			: never

/** The value one key into `A`; `never` when `A` has no such key. */
export type JsonStep<A, K> = unknown extends A
	? unknown
	: A extends ReadonlyArray<infer E>
		? K extends number
			? E
			: never
		: A extends object
			? K extends keyof A
				? A[K]
				: never
			: never

/**
 * Every path into a value of type `A`, as a tuple of keys, up to eight deep.
 * A document typed `unknown` (`jsonb()` with no schema) takes any keys.
 */
export type JsonPath<A, D extends number = 8> = [D] extends [never]
	? ReadonlyArray<JsonKey>
	: unknown extends A
		? readonly [JsonKey, ...Array<JsonKey>]
		: { [K in JsonKeyOf<A>]: readonly [K] | readonly [K, ...JsonPath<JsonStep<A, K>, Prev[D]>] }[JsonKeyOf<A>]

/** The value at `path` inside `A`, before SQL adds `null` for a missing key. */
export type JsonPathValue<A, P> = P extends readonly [infer K, ...infer Rest] ? JsonPathValue<JsonStep<A, K>, Rest> : A

/**
 * What `jsonContains` takes: part of a document, at any depth. Containment is
 * read on the stored JSON, so a field whose schema transforms (a `Date` stored
 * as a string) is written in its stored form.
 */
export type JsonContained<A> = unknown extends A
	? unknown
	: A extends ReadonlyArray<infer E>
		? ReadonlyArray<JsonContained<E>>
		: A extends object
			? { readonly [K in keyof A]?: JsonContained<A[K]> }
			: A

/** The schema at `path`, or why there is none. */
export type JsonPathSchema =
	| { readonly _tag: "Found"; readonly schema: Schema.Codec<unknown, unknown> }
	| { readonly _tag: "Missing"; readonly reason: string }

const missing = (reason: string): JsonPathSchema => ({ _tag: "Missing", reason })

/** A union's members that hold a value: `null` and `undefined` are where a key reads as SQL NULL. */
const valueMembers = (types: ReadonlyArray<SchemaAST.AST>): ReadonlyArray<SchemaAST.AST> =>
	types.filter((member) => member._tag !== "Null" && member._tag !== "Undefined")

/**
 * The node one key into `ast`. A node with its own encoding is refused: the
 * document stores its encoded form, whose keys need not be the decoded ones
 * (`Schema.encodeKeys`, a class), so the path would read the wrong field.
 */
const step = (ast: SchemaAST.AST, key: JsonKey): SchemaAST.AST | string => {
	if (ast._tag === "Unknown" || ast._tag === "Any") return ast
	if (ast._tag === "Suspend") return step(ast.thunk(), key)
	if (ast.encoding !== undefined) return "its stored form is a transformation of its type"
	switch (ast._tag) {
		case "Union": {
			const found = valueMembers(ast.types).map((member) => step(member, key))
			const asts = found.filter((result): result is SchemaAST.AST => typeof result !== "string")
			if (asts.length === 0) return found.find((result) => typeof result === "string") ?? "no member holds a value"
			return asts.length === 1 ? asts[0]! : Schema.Union(asts.map((member) => Schema.make(member))).ast
		}
		case "Objects": {
			if (typeof key !== "string") return `an object has no index ${key}`
			const field = ast.propertySignatures.find((signature) => signature.name === key)
			if (field !== undefined) return field.type
			const index = ast.indexSignatures[0]
			return index !== undefined ? index.type : `no field "${key}"`
		}
		case "Arrays": {
			if (typeof key !== "number") return `an array has no field "${key}"`
			const element = (key >= 0 ? ast.elements[key] : undefined) ?? ast.rest[0]
			return element ?? `no element ${key}`
		}
		default:
			return `a ${ast._tag} has no fields`
	}
}

/**
 * The schema of the value at `path` inside a document `schema` decodes, read
 * off the schema itself: struct fields, records, arrays and tuples, through
 * unions, `NullOr`, optional keys and `suspend`. A document typed `Unknown`
 * reads `Unknown` at every path. The caller adds `null`, which SQL returns for
 * a missing key.
 */
export const jsonPathSchema = (schema: Schema.Top, path: ReadonlyArray<JsonKey>): JsonPathSchema => {
	let ast: SchemaAST.AST = schema.ast
	for (const [depth, key] of path.entries()) {
		const next = step(ast, key)
		if (typeof next === "string") return missing(`at ${JSON.stringify(path.slice(0, depth + 1))}: ${next}`)
		ast = next
	}
	return { _tag: "Found", schema: Schema.make(ast) as unknown as Schema.Codec<unknown, unknown> }
}

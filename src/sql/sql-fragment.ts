import { Data } from "effect"
import { activeSqlSyntax } from "./sql-syntax"
import { hidden, noteColumn } from "./render-tracker"

// ClickHouse string escaping

// `;` is emitted as its hex escape: some ClickHouse-compatible HTTP gateways
// split statements on the raw byte even inside string literals, truncating the
// query mid-literal. The server unescapes `\x3B` back to `;`, so results are
// byte-identical.
//
// `__PARAM_` gets the same treatment, for the same reason one layer up: params
// are resolved by rewriting `__PARAM_<kind>_<name>__` across the *finished* SQL
// (see `resolveParams`), which cannot tell an executable placeholder from one
// that happens to sit inside an already-escaped literal. A value of
// `__PARAM_string_serviceName__` used to be replaced with that param's rendered
// literal — quotes included — and those quotes closed the literal it landed in,
// letting a second user-controlled param continue as SQL. Escaping one `_` here
// means no user value can ever spell a placeholder, so the rewrite can only
// ever see the real ones. `\x5F` unescapes to `_`, so values stay byte-identical.
//
// Order matters: this runs after the backslash escape, or the `\` it introduces
// would itself be escaped.
export function escapeClickHouseString(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/'/g, "\\'")
		.replace(/;/g, "\\x3B")
		.replace(/__PARAM_/g, "\\x5F_PARAM_")
}

/** A string as a ClickHouse literal: quoted, and escaped as above. */
export const quoteClickHouseString = (value: string): string => `'${escapeClickHouseString(value)}'`

/** A string literal in the syntax of the dialect being compiled for, or
 *  ClickHouse's outside a compile. */
const quoteString = (value: string): string => (activeSqlSyntax()?.quoteString ?? quoteClickHouseString)(value)

/** One identifier in the syntax of the dialect being compiled for. ClickHouse
 *  names are written bare, which is also the rendering outside a compile. */
export const quoteIdent = (name: string): string => activeSqlSyntax()?.quoteIdent(name) ?? name

/** A dotted path (`db.table`, `alias.Column`) with each segment quoted. */
export const quoteIdentPath = (path: string): string => path.split(".").map(quoteIdent).join(".")

// SQL Fragment AST

export type SqlFragment = Data.TaggedEnum<{
	/** Raw SQL string — no escaping. For ClickHouse-specific syntax. */
	Raw: { readonly sql: string }
	/** A string literal, quoted and escaped by the dialect being compiled for */
	Str: { readonly value: string }
	/** Integer parameter: produces the number as string, rounded */
	Int: { readonly value: number }
	/**
	 * An identifier, quoted by the dialect being compiled for.
	 *
	 * `name` is one identifier and is never split, so a ClickHouse `Nested`
	 * column such as `Events.Name` stays whole. `qualifier` is the dotted path in
	 * front of it (`alias`, `db.table`), quoted segment by segment.
	 */
	Ident: { readonly name: string; readonly qualifier?: string }
	/** A list of fragments joined by a separator (empty strings from When(false) are filtered) */
	Join: { readonly separator: string; readonly fragments: ReadonlyArray<SqlFragment> }
	/** An aliased expression: <expr> AS <alias> */
	As: { readonly expr: SqlFragment; readonly alias: string }
	/** A conditional fragment — included only when the condition is true */
	When: { readonly condition: boolean; readonly fragment: SqlFragment }
	/**
	 * SQL assembled only when the fragment is compiled, not when it is built.
	 *
	 * The point is *where the failure lands*. A fragment that splices an inner
	 * query's SQL has to compile that query, and compiling it eagerly puts the
	 * failure in whatever function built the fragment — outside the `Effect` the
	 * outer `compile` runs in, so a bad value reaches production as a synchronous
	 * throw rather than a typed failure. Deferring the work to compile time puts
	 * it back inside.
	 *
	 * `known` marks SQL the builder itself writes (an operator, a built-in
	 * function), whose parts the render tracker may count. Anything else is
	 * opaque to it: see `render-tracker.ts`.
	 */
	Lazy: { readonly render: () => string; readonly known?: boolean }
}>

const Frag = Data.taggedEnum<SqlFragment>()

// Constructors

export const raw = (sql: string): SqlFragment => Frag.Raw({ sql })
export const str = (value: string): SqlFragment => Frag.Str({ value })
export const int = (value: number): SqlFragment => Frag.Int({ value })
export const ident = (name: string, qualifier?: string): SqlFragment =>
	Frag.Ident(qualifier === undefined ? { name } : { name, qualifier })
/** A dotted path such as `db.table`, split into qualifier and name. */
export const identPath = (path: string): SqlFragment => {
	const dot = path.lastIndexOf(".")
	return dot === -1 ? ident(path) : ident(path.slice(dot + 1), path.slice(0, dot))
}
export const join = (separator: string, ...fragments: ReadonlyArray<SqlFragment>): SqlFragment =>
	Frag.Join({ separator, fragments })
export const as_ = (expr: SqlFragment, alias: string): SqlFragment => Frag.As({ expr, alias })
export const when = (condition: boolean, fragment: SqlFragment): SqlFragment =>
	Frag.When({ condition, fragment })
export const lazy = (render: () => string): SqlFragment => Frag.Lazy({ render })
/** {@link lazy} for SQL the builder writes itself, which the render tracker may look inside. */
export const known = (render: () => string): SqlFragment => Frag.Lazy({ render, known: true })

// Compiler

export const compile: (fragment: SqlFragment) => string = Frag.$match({
	Raw: ({ sql }) => sql,
	Str: ({ value }) => quoteString(value),
	Int: ({ value }) => String(Math.round(value)),
	Ident: ({ name, qualifier }) => {
		noteColumn(qualifier === undefined ? name : `${qualifier}.${name}`)
		return qualifier === undefined ? quoteIdent(name) : `${quoteIdentPath(qualifier)}.${quoteIdent(name)}`
	},
	Join: ({ separator, fragments }) => fragments.map(compile).filter(Boolean).join(separator),
	As: ({ expr, alias }) => `${compile(expr)} AS ${quoteIdent(alias)}`,
	When: ({ condition, fragment }) => (condition ? compile(fragment) : ""),
	Lazy: ({ render, known }) => (known === true ? render() : hidden(render)),
})

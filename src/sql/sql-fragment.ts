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

// ClickHouse identifiers

const PLAIN_CLICKHOUSE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/

// The words ClickHouse reads as something else where a statement names something of its own:
// a literal (`ORDER BY null`), a modifier (`GROUP BY rollup`, `FROM x AS all`) or the start
// of a query (`WITH select AS (…)`). Found by using each of `system.keywords` (25.8 and 26.8)
// as a select key in GROUP BY, ORDER BY and HAVING, as a table and join alias and as a CTE
// name; every other keyword is an ordinary name in all of those.
const RESERVED_CLICKHOUSE_NAMES = new Set([
	"all", "cube", "distinct", "false", "inf", "infinity", "nan", "not", "null", "recursive", "rollup", "select", "top", "true",
])

/**
 * One ClickHouse identifier: a column where it is read or written. A plain name
 * (letters, digits, `_`, and dots for a Nested column such as `Events.Name`) is
 * written bare, as it always was, so the SQL of a table's own expressions (an
 * index, a MATERIALIZED column) does not change under a schema snapshot. Any
 * other is quoted in backticks, so a name with a space or a `-` is one name and
 * a name can never be read as SQL. The escapes are the string literal's, `;`
 * and the param marker included, for the reasons given there.
 */
export const quoteClickHouseIdent = (name: string): string =>
	PLAIN_CLICKHOUSE_IDENT.test(name) && !name.includes("__PARAM_") ? name : backticked(name)

const backticked = (name: string): string => `\`${escapeClickHouseString(name).replace(/`/g, "\\`")}\``

/** One identifier in the syntax of the dialect being compiled for, or
 *  ClickHouse's outside a compile. */
export const quoteIdent = (name: string): string => (activeSqlSyntax()?.quoteIdent ?? quoteClickHouseIdent)(name)

/**
 * A name the statement itself introduces, and that name wherever the statement
 * uses it: a select key (also in GROUP BY, ORDER BY and DISTINCT ON), a source
 * or join alias, a CTE name. Where the dialect would write it bare (ClickHouse),
 * two kinds are quoted all the same. One with a dot, since it is never a path:
 * `spans.Events.Name` reads the Nested column, and `AS Events.Name` is a syntax
 * error. And the words above: a column named `null` is fine as `t.null`, but
 * `ORDER BY null` orders by the literal.
 */
export const quoteAlias = (name: string): string => {
	const quoted = quoteIdent(name)
	return quoted === name && (name.includes(".") || RESERVED_CLICKHOUSE_NAMES.has(name.toLowerCase())) ? backticked(name) : quoted
}

/** A dotted path of names the statement refers to (`db.table`, an alias in front of a column), each segment quoted. */
export const quoteIdentPath = (path: string): string => path.split(".").map(quoteAlias).join(".")

/**
 * A table where a statement names one: a dotted path of identifiers. A name
 * that is not one is written as given where the dialect says so (ClickHouse,
 * whose external tables may be a table function or a subquery).
 */
export const quoteTable = (name: string): string => {
	const syntax = activeSqlSyntax()
	return (syntax === undefined || syntax.rawTableNames === true) && !PLAIN_CLICKHOUSE_IDENT.test(name) ? name : quoteIdentPath(name)
}

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
	As: ({ expr, alias }) => `${compile(expr)} AS ${quoteAlias(alias)}`,
	When: ({ condition, fragment }) => (condition ? compile(fragment) : ""),
	Lazy: ({ render, known }) => (known === true ? render() : hidden(render)),
})

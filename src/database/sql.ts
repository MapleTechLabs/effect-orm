// `Db.sql`: a statement written as a template, every `${value}` bound.
//
// The template does not know its database, so it keeps the text and the values
// apart and is rendered by the `Database` that runs it: `$1, $2, ...` for
// Postgres, an escaped literal for ClickHouse, which takes no bound values over
// HTTP. Nothing in a value can become SQL.

import { Effect } from "effect"
import { checkedLiteral, type Dialect } from "../ch/dialect"
import { QueryBuilderError } from "../ch/errors"
import { DatabaseError } from "./errors"

const SqlTemplateTag = "@maple-dev/effect-orm/SqlTemplate"
const IdentifierTag = "@maple-dev/effect-orm/SqlIdentifier"

/** A name written as an identifier, quoted by the dialect. From `sql.identifier`. */
export interface SqlIdentifier {
	readonly _tag: typeof IdentifierTag
	readonly name: string
}

/** A statement from `sql\`...\``: text and values, rendered per dialect when it runs. */
export interface SqlTemplate {
	readonly _tag: typeof SqlTemplateTag
	readonly strings: ReadonlyArray<string>
	readonly values: ReadonlyArray<unknown>
}

/**
 * A statement with every `${value}` bound, never spliced into the text. A
 * `sql\`...\`` inside another is spliced as SQL, so statements compose.
 *
 * ```ts
 * Db.execute(Db.sql`UPDATE api_keys SET revoked = true WHERE family = ${family}`)
 * ```
 */
export const sql: {
	(strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>): SqlTemplate
	/** A table or column name, quoted by the dialect: `sql\`SELECT * FROM ${sql.identifier(table)}\``. */
	readonly identifier: (name: string) => SqlIdentifier
} = Object.assign(
	(strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>): SqlTemplate => ({
		_tag: SqlTemplateTag,
		strings: [...strings],
		values,
	}),
	{ identifier: (name: string): SqlIdentifier => ({ _tag: IdentifierTag, name }) },
)

const isIdentifier = (value: unknown): value is SqlIdentifier =>
	typeof value === "object" && value !== null && "_tag" in value && value._tag === IdentifierTag

export const isSqlTemplate = (value: unknown): value is SqlTemplate =>
	typeof value === "object" && value !== null && "_tag" in value && value._tag === SqlTemplateTag

// ClickHouse writes identifiers bare, so only plain names are accepted, for
// every dialect: letters, digits and `_`, dotted for `schema.table`.
const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/

const identifier = (dialect: Dialect, name: string): string => {
	if (!PLAIN_NAME.test(name)) {
		throw new QueryBuilderError({
			code: "InvalidLiteral",
			message: `sql.identifier: ${JSON.stringify(name)} is not a plain identifier (letters, digits, _, dotted for schema.table)`,
		})
	}
	return name
		.split(".")
		.map((segment) => dialect.quoteIdent(segment))
		.join(".")
}

/** Text with the dialect's placeholders, and the values they bind. */
export const renderTemplate = (
	template: SqlTemplate,
	dialect: Dialect,
): Effect.Effect<{ readonly sql: string; readonly parameters: ReadonlyArray<unknown> }, DatabaseError> =>
	Effect.try({
		try: () => {
			const parameters: Array<unknown> = []
			const render = (current: SqlTemplate): string =>
				current.strings.reduce((text, part, index) => {
					if (index === 0) return part
					const value = current.values[index - 1]
					if (isSqlTemplate(value)) return text + render(value) + part
					if (isIdentifier(value)) return text + identifier(dialect, value.name) + part
					if (dialect.params._tag === "inline") return text + checkedLiteral(dialect, value, "a sql`` value") + part
					parameters.push(value)
					return text + dialect.params.placeholder(parameters.length, "") + part
				}, "")
			return { sql: render(template), parameters }
		},
		catch: (cause) =>
			new DatabaseError({
				message: cause instanceof QueryBuilderError ? cause.message : String(cause),
				sql: template.strings.join("?"),
				reason: cause instanceof QueryBuilderError ? cause.code : "InvalidLiteral",
				cause,
			}),
	})

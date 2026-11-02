// Column casing: a table's database column names derived from its keys.
//
// The rule is drizzle-orm's (`casing: "snake_case"`), word for word, so a
// schema drizzle-kit created keeps its names: `orgId` and `OrgId` are
// `org_id`, `HTTPStatus` is `http_status`, `address2` stays `address2`. It runs
// once, where the table is defined, and lands on each column as its `sqlName`;
// the query builder never sees a casing, only names, so decoding still reads
// every row under the exact alias it wrote.

/**
 * How a table names a column in the database when the column gives no `name`:
 * `"snake_case"` stores `orgId` as `org_id`; `"camelCase"` stores `org_id` as
 * `orgId`. A column's own `name` wins.
 */
export type Casing = "snake_case" | "camelCase"

const words = (key: string): ReadonlyArray<string> =>
	key.replace(/['’]/g, "").match(/[\da-z]+|[A-Z]+(?![a-z])|[A-Z][\da-z]+/g) ?? []

const toSnakeCase = (key: string): string => words(key).map((word) => word.toLowerCase()).join("_")

const toCamelCase = (key: string): string =>
	words(key)
		.map((word, position) => (position === 0 ? word.toLowerCase() : `${word[0]!.toUpperCase()}${word.slice(1)}`))
		.join("")

/** The database name `casing` gives `key`, or `undefined` when it is the key itself. */
export const casedName = (key: string, casing: Casing | undefined): string | undefined => {
	if (casing === undefined) return undefined
	const name = casing === "snake_case" ? toSnakeCase(key) : toCamelCase(key)
	return name === "" || name === key ? undefined : name
}

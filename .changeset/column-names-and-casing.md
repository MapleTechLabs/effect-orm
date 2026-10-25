---
"@maple-dev/effect-orm": minor
---

Column names apart from keys, on both dialects. `CH.column(type, { name: "org_id" })` now does
what `PG.column` already did: the column is stored as `org_id` and read, written, filtered and
indexed as its key. A new `casing` table option (`"snake_case"` or `"camelCase"`, the `Casing`
type) names every column that gives no `name` from its key, by drizzle-orm's rule: `orgId` is
`org_id`, `HTTPStatus` is `http_status`. The DDL, migrations, inserts, updates, upsert targets,
`returning` and tenant scope use the database name; rows decode under the key. A ClickHouse
materialized view whose target renames a column records a problem, since ClickHouse fills the
target by database name.

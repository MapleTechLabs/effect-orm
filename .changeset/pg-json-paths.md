---
"@maple-dev/effect-orm": minor
---

Typed jsonb paths on Postgres, read off the column's schema. `PG.jsonPath($.payload, "profile", "city")` on a `PG.jsonb(Schema.Struct({ profile: Schema.Struct({ city: Schema.String }) }))` column is an `Expr<string | null>` that compiles to `("payload" -> 'profile' -> 'city')` and decodes with the field's own schema; only paths the schema has type-check, and a number key indexes an array. `jsonPathText` reads with `->>`, `jsonContains` filters with `@>` (bound as `$n::jsonb`), and `jsonSet` writes one path with `jsonb_set` inside an UPDATE's `set`, without reading the row first. Values compared with a path, and the value of a `jsonSet`, are encoded by the field's schema and bound as JSON. A path the schema does not have, or one through a field whose stored form differs from its type, is a defect at compile time. The path types (`JsonPath`, `JsonPathValue`, `JsonContained`, …) and `jsonPathSchema` are exported for helpers.

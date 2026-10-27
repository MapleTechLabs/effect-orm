---
"@maple-dev/effect-orm": minor
---

Relation filters and counts in `/database`, as Prisma's `some` / `none` / `every` and `_count`. `findMany`'s `where` gets the relations of its level as a second argument: `where: ($, r) => [r.posts.some(($) => [$.published.eq(false)])]`. `Db.related(schema.users, $)` gives the same filters on a builder query, and `r.posts.count(where?)`, an `Expr<number>` for a `select` or a `where`. The filters are correlated `EXISTS` / `NOT EXISTS` subqueries. `_count: { posts: true }` in `findMany` adds `_count: { posts: number }` to each row, with one grouped statement per level. When both tables declare a tenant column, the subquery matches the outer row's tenant, and a filter under a scoped query stays `"single-tenant"`. See docs/relations.md.

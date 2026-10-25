---
"@maple-dev/effect-orm": minor
---

`Db.defineRelations(tables, (r) => ...)` and `Db.findMany(schema.table, { where, orderBy, limit, with })` in `/database` read rows with their related rows, nested to any depth, as Drizzle's relational queries and Prisma's `include` do. `r.one` and `r.many` are checked against the tables. Each level of `with` is one statement, `WHERE <key> IN (...)` over the keys of the level above, decoded through its own row codec, so a nested `timestamptz` is a `DateTime.Utc`. A level whose parent rows carry one tenant is pinned to it, and `requireTenantScope` checks every level. See docs/relations.md and design/relations.md.

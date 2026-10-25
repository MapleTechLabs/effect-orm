---
"@maple-dev/effect-orm": minor
---

`excluded(columns)` and `excludedAll(except?)` build an `onConflictDoUpdate` `set` that copies columns from the row proposed for insertion: `set: excluded(["name", "rent"])` writes `SET "name" = "excluded"."name", "rent" = "excluded"."rent"`. `excludedAll` copies every column the insert writes, except the named ones and the conflict target's columns; a column the rows leave out keeps its old value. Names are checked against the table's writable columns. Setting the tenant column from the proposed row (here or in the callback form) now keeps the rows' tenant scope instead of making the insert cross-tenant. Postgres.

---
"@maple-dev/effect-orm": minor
---

`/database` adds `paginate(query, { orderBy, after, limit }, params?)`: keyset (cursor) pagination over a built query. It adds a seek on the sort key, the `ORDER BY` and `LIMIT limit + 1`, and returns `{ rows, nextCursor }`, with no `OFFSET`. With one direction the seek is a row comparison, `(a, b) < (?, ?)`; with mixed directions it is the expanded `OR` form, bounded on the first key. The key is one or more selected, non-null aliases; end it with a unique column. The cursor is base64url text, encoded through the key columns' schemas. A cursor that does not decode, or that was written for another sort key, fails with the new `InvalidCursor` error. Postgres and ClickHouse.

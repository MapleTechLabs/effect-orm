---
"@maple-dev/effect-orm": patch
---

Values that cannot become SQL fail compilation with a `QueryBuilderError` (`InvalidLiteral`) instead of throwing: a bigint compared against a non-integer column, a non-string `like`/`notLike`/`ilike` pattern, `lit()` of anything but a string or number (it wrote `[object Object]`), a non-numeric arithmetic operand, an invalid `Date`, and an unparseable string or invalid `Date` for a Postgres timestamp. A non-expression in a `select` record is a `QueryBuilderDefect` naming the alias, like a malformed `orderBy`.

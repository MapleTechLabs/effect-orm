---
"@maple-dev/effect-orm": minor
---

Add the `/sqlite` query entry with SQLite codecs, functions and positional bindings. Use
`sqliteDialect` with an Effect SQLite SqlClient, or `d1Dialect` for Cloudflare D1's binding limit
and explicit refusal of interactive transactions. `table` is a query schema only: SQLite DDL and
migration generation are not implemented yet.

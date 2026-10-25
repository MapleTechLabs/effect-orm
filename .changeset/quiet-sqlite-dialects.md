---
"@maple-dev/effect-orm": minor
---

Add the `/sqlite` query entry with SQLite codecs, functions and positional bindings. Use
`sqliteDialect` with an Effect SQLite SqlClient, or `d1Dialect` for Cloudflare D1's binding limit
and explicit refusal of interactive transactions. `timestamp` stores SQLite's own
`YYYY-MM-DD HH:MM:SS.SSS` UTC text, so it compares correctly with what `strftime` writes; `LIKE`
escapes with `\` as on every dialect; text with U+0000 and integers past 2^53 are refused rather
than silently changed.

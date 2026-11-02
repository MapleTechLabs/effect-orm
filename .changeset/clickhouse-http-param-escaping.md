---
"@maple-dev/effect-orm": patch
---

`ClickhouseHttpClient` escapes bound parameters the way ClickHouse reads them. A string with a
newline, tab or NUL no longer fails with `BAD_QUERY_PARAMETER`, and a backslash is no longer
read as the start of an escape sequence, which silently changed the value. Arrays are sent as
ClickHouse literals, so arrays of strings now bind at all (#38).

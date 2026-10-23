---
"@maple-dev/effect-orm": patch
---

Two Postgres values the server typed wrong from context now compile correctly. A `param.of(type)` selected on its own is written `CAST($n AS <type>)`, so a boolean or array comes back as itself instead of text that fails to decode. A fractional value compared with an integer column binds as `$n::numeric` instead of failing with `invalid input syntax for type bigint`. Nothing else is cast: whole numbers, params compared with columns, inserts and `real` columns keep untyped placeholders (and their indexes). `param.of` also no longer confuses two types that share a codec (`int8` and `float8`).

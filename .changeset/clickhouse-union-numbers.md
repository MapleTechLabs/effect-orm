---
"@maple-dev/effect-orm": patch
---

On ClickHouse, a `unionAll` ordered by a numeric column whose branches may differ in type (`Id + 1`
and `Id - 1`, or a `UInt32` and an `Int64` column) no longer fails with "Data types Variant/Dynamic
are not allowed in ORDER BY keys". The union's ORDER BY sorts such a column by
`toFloat64(x), accurateCastOrNull(x, 'Int128')`, which keeps integers past 2^53 in exact order; the
values themselves are not converted.

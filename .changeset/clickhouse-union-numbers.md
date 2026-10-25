---
"@maple-dev/effect-orm": patch
---

On ClickHouse, a `unionAll` column of numbers whose branches may differ in type (`Id + 1` and
`Id - 1`, or a `UInt32` and an `Int64` column) is selected as `toFloat64(…)` in each branch.
ClickHouse had made it a `Variant`, and an ORDER BY on it failed with "Data types Variant/Dynamic
are not allowed in ORDER BY keys". Numbers decode to JS numbers either way.

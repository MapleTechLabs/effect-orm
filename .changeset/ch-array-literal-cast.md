---
"@maple-dev/effect-orm": patch
---

On ClickHouse, an array or map compared against a column is cast to the column's type: `$.Ids.eq([0, 4294967296])` writes `CAST([0, 4294967296] AS Array(Nullable(Int64)))`. Uncast, ClickHouse inferred the literal's element type from its values (`Array(UInt64)` here) and could refuse the comparison with `ILLEGAL_TYPE_OF_ARGUMENT`.

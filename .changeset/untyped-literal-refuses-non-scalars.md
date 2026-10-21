---
"@maple-dev/effect-orm": patch
---

Refuse values with no SQL literal instead of writing `String(value)`. A value compared against, or passed to, an expression with no column type (a `defineFn` result, `untypedExpr`, an untyped `dynamicColumn`) used to be written raw when it was not a string, number, boolean or date: an array or object from a request became part of the SQL (`toFloat64OrNull(x) > 1) OR (1=1`). It now fails compilation with a `QueryBuilderError` (`InvalidLiteral`). `null` is written as `NULL` and a bigint as its digits, as before.

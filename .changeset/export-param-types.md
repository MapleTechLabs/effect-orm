---
"@maple-dev/effect-orm": patch
---

`ParamEntry`, `OptionalParamEntry`, `OptionalParams` and `ParamsIn` are exported from every dialect entry point. A package that exports a query with a `param.*`, or a `defineFn` helper, failed `tsc --declaration` with TS4023 / TS2742: their types name these, and tsc could only reach them through a hashed internal chunk. The package-consumer check now emits declarations for exported queries with plain, optional (`when` / `whenTrue`) and union-named params, joins, CTEs, subqueries, unions and a `defineFn` helper, on TypeScript 7 and 5.

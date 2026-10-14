---
"@maple-dev/effect-orm": patch
---

`ParamEntry` and `ParamsIn` are exported from every dialect entry point. A package that exports a query with a `param.*`, or a `defineFn` helper, failed `tsc --declaration` with TS4023 / TS2742: their types name these, and tsc could only reach them through a hashed internal chunk. The package-consumer check now emits declarations for both, on TypeScript 7 and 5.

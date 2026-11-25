---
"@maple-dev/effect-orm": patch
---

On ClickHouse, a string literal matched against a pattern that is an expression is now written `materialize('…')`: `lit(path).startsWith($.Prefix)`, `lit(text).contains($.Word)` and `lit(text).like($.Pattern)` failed on ClickHouse 26.2 with "Function 'like' doesn't support search with non-constant needles in constant haystack". The same server does not match an empty string against `'%%'`, which an empty literal ran into: `lit("").contains($.Word)`, `startsWith` and `endsWith` are now written `Word = ''`, which is what they mean. A column on the left, or a pattern that is a string, compiles as before.

The SQL of such an expression changes, so a table whose DDL holds one (a `MATERIALIZED` column, an index or sorting key written this way) shows that definition as changed in the next migration. A constant built by a function, such as `lower(lit("A")).startsWith($.Name)`, is not rewritten and still fails on 26.2.

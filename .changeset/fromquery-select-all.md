---
"@maple-dev/effect-orm": patch
---

A bare `select()` over a subquery or union (`CH.fromQuery(inner, "w").select()`, `CH.fromUnion(union, "u").select()`) selects every alias the source selects, as its type already said. It died with `QueryBuilderDefect: select() is required`, because the derived source has no column list until its own SELECT is evaluated.

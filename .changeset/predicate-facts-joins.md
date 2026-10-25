---
"@maple-dev/effect-orm": minor
---

A `where` that proves a joined column not NULL now narrows that column for a later `select`. `$.l.Id.isNotNull()` and `$.l.Id.eq(…)` prove it, alone or under `.and(…)`, `and(…)` or the `where` list. The row type and the derived row schema both drop `| null`, so `leftJoin(…).where(($) => [$.l.Id.isNotNull()]).select(($) => ({ id: $.l.Id }))` reads `id: string`, and a NULL in that column fails to decode. `or`, `not`, `when` and a `select` made before the `where` keep `| null`. `Condition` has a second type parameter for these facts; it defaults to none, so existing code does not change.

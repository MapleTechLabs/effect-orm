---
"@maple-dev/effect-orm": minor
---

`CurrentDialect`, a `Context.Reference`, sets the dialect a `compile` writes for when no `options.dialect` is given: `CH.compile(query, params).pipe(Effect.provideService(CH.CurrentDialect, postgresDialect))`. The order is `options.dialect`, then `CurrentDialect`, then the entry's dialect. A compile's state (its dialect, syntax, bound values and failures) is now kept in the context of the fiber that runs it, not in module state, so compiles for two dialects in concurrent fibers stay independent.

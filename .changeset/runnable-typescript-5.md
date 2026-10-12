---
"@maple-dev/effect-orm": patch
---

A concrete insert is assignable to `Runnable` (from `/database`) and accepted by `compile` under TypeScript 5.x again. Both took `CHInsert<any, ...>`, which TypeScript 5 compares method by method, and the generic `onConflictDoUpdate` failed that comparison; they now take an insert by its tag, state and phantom (`AnyInsert`). A workaround such as `type Runnable = Orm.Runnable | { readonly _tag: "CHInsert" }` can be removed.

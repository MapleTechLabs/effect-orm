---
"@maple-dev/effect-orm": minor
---

`Db.afterCommit(effect)` queues work, such as an SMS or an HTTP call, to run after the outermost transaction commits, and never after a rollback. It delegates to Effect's `SqlClient.afterCommit` and, like `requireTransaction`, adds `Transaction` to the requirements, so queueing outside a transaction does not compile. A failing hook does not fail the committed transaction: its cause goes to the `ErrorReporter`s in context and to an error log, and the next hook still runs.

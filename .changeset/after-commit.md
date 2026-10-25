---
"@maple-dev/effect-orm": minor
---

`Db.afterCommit(effect)` queues work, such as an SMS or an HTTP call, to run after the outermost transaction commits, and never after a rollback. Like `requireTransaction`, it adds `Transaction` to the requirements. Hooks run in order, outside the transaction, with the services of the place they were queued. A savepoint that rolls back drops its hooks, and a failed `retry` attempt drops its hooks. A failing hook does not fail the committed transaction: its cause goes to the `ErrorReporter`s in context and to an error log, and the next hook still runs. Where nothing would run the work (a `Transaction` provided by hand, a transaction that has ended, or one opened by a plain `sql.withTransaction`), `afterCommit` dies with the new `AfterCommitUnavailable`.

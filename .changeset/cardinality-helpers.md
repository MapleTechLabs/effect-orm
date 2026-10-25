---
"@maple-dev/effect-orm": minor
---

`/database` adds `runOne`, `runOption` and `runNonEmpty`: `run` with a check on how many rows came back. `runOne` wants exactly one row, `runOption` returns an `Option` and wants at most one, and `runNonEmpty` returns a `NonEmptyReadonlyArray` and wants at least one. A wrong count fails with `ResultCardinalityError` (`expected`, `rows`) in the error channel. The query runs as written, with no `LIMIT` added, so a duplicate row is found, not hidden.

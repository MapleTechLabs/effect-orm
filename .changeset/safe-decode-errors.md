---
"@maple-dev/effect-orm": minor
---

`CompiledQueryDecodeError` is safe to log. It carries `dialect`, `collection`, `column` and `issues` (the Schema path, issue kind and expected type of each issue), and its `message` names them: `Compiled query row 0 did not match its declared output schema: at ["phone"] expected number`. No field holds a row value, so `toString()`, `JSON.stringify`, `util.inspect` and `Cause.pretty` print none. The Schema error moves from `cause` to the non-enumerable `schemaError` property, because it can quote the value (the ClickHouse `DateTime` codec did). New `formatDecodeError(error, { verbose? })` gives a one-line summary for a log; `verbose: true` appends the raw Schema message. Breaking for code that read `error.cause` or built the error by hand: read `error.schemaError`, and pass `issues`.

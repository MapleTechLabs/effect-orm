---
"@maple-dev/effect-orm": minor
---

Statement observation and parameter redaction for `Database`.

- `observeExit` on `fromSqlClient` is called with every statement once it ends: its `db.*` names, tenant scope, route, duration, row count, or `error.type`.
- `spanParameters: true` puts the bound values on the statement span as `db.query.parameter.<index>`. It is off by default, so spans carry no values.
- A value given as `Redacted` (for example in a column typed `brand(text, Schema.RedactedFromValue(Schema.String))`) is marked in `CompiledQuery.sensitiveParameters`. Spans write it as `<redacted>`, and `observeExit` gets it still `Redacted`. The driver gets the plain value.
- `sql\`...\`` binds a `Redacted` value as its plain value. It used to bind the `Redacted` object, which the driver wrote as the text `<redacted>`. On ClickHouse, which writes values into the statement text, it refuses one.

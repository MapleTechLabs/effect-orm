---
"@maple-dev/effect-orm": minor
---

A statement's client span is now the only span it gets. It carries `db.query.text` (the statement as sent), and on failure `db.response.status_code` (the SQLSTATE) beside `error.type`, so the SQL driver's own span, which repeated the query text under the database name, runs untraced. Pass `driverSpans: true` to `fromSqlClient` to keep it as a child for what only the driver records, such as `server.address` or connection waits. `observe` runs inside the statement span, so attributes it annotates land there.

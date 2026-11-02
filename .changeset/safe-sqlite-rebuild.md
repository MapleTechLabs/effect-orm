---
"@maple-dev/effect-orm": patch
---

Generated SQLite rebuilds check live inbound foreign keys before copying or dropping the old table. A referenced table is refused instead of letting a transaction-wrapped DROP fire CASCADE or SET NULL actions. The guard works in a D1 batch and rolls back with the migration; ordinary rebuilds still run. Older generated SQL must be reviewed or regenerated before applying it.

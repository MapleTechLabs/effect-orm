---
"@maple-dev/effect-orm": minor
---

`makeRepository(table, { idColumn, tenantColumn })` in `/database` builds the plain CRUD of a table on the `Database` in context, as `SqlModel.makeRepository` does for a `Model.Class`: `insert`, `insertVoid`, `update`, `updateVoid`, `findById` and `delete`. `findById` and `update` return an `Option`. Inserts take the `tableSchemas(table).insert` row and updates its `update` row. A table with a tenant column gets a `TenantRepository`: every method takes the tenant first, writes or filters the tenant column from it, and compiles as `"single-tenant"`, so a call cannot read or write another tenant's rows. A patch cannot change the id or the tenant column. On ClickHouse, which has no `RETURNING`, use `insertVoid`, `updateVoid` (a mutation that waits), `findById` and `delete` (a lightweight delete that waits).

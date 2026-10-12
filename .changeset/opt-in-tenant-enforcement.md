---
"@maple-dev/effect-orm": minor
---

Tenant scoping is now opt-in and enforceable. `fromSqlClient` / `layerSqlClient` take `requireTenantScope: true`, which refuses an undeclared `"cross-tenant"` statement with a `TenantScopeViolation` defect. Compiled queries carry `crossTenantDeclared` when the opt-out was explicit, and unions, inserts, updates and deletes gain `.crossTenant()`. `rawCompiledQuery`'s `tenantScope` is now optional and defaults to `"cross-tenant"`.

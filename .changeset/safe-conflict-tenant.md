---
"@maple-dev/effect-orm": patch
---

An upsert is single-tenant only when its conflict-update path also proves the existing row's tenant. A tenant-inclusive column target or an explicit tenant predicate can prove it; otherwise `requireTenantScope` refuses the statement before execution. This prevents an insert for one tenant from updating another tenant through a shared conflicting ID.

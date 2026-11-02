import { expect, it } from "vitest"
import * as PG from "../postgres"

const Rows = PG.table("rows", {
	columns: { id: PG.text, org: PG.text, value: PG.text },
	primaryKey: ["id"],
	tenantColumn: "org",
})
const insert = PG.insertInto(Rows).values({ id: "same", org: PG.param.string("org"), value: "new" })
const scope = (query: typeof insert) => PG.compileUnsafe(query, { org: "a" }).tenantScope

it("does not infer an existing conflict row's tenant from the inserted values or SET", () => {
	expect(scope(insert.onConflictDoUpdate({ target: ["id"], set: { value: "new" } }))).toBe("cross-tenant")
	expect(scope(insert.onConflictDoUpdate({ target: ["id"], set: { org: "a" } }))).toBe("cross-tenant")
	expect(scope(insert.onConflictDoUpdate({ target: { constraint: "rows_pkey" }, set: { value: "new" } }))).toBe("cross-tenant")
})

it("proves the conflict row's tenant through the target or an ANDed tenant predicate", () => {
	expect(scope(insert.onConflictDoUpdate({ target: ["org", "id"], set: { value: "new" } }))).toBe("single-tenant")
	expect(scope(insert.onConflictDoUpdate({
		target: ["id"], set: { value: "new" },
		where: (existing, excluded) => existing.org.eq(excluded.org).and(existing.value.neq("locked")),
	}))).toBe("single-tenant")
	expect(scope(insert.onConflictDoUpdate({
		target: ["id"], set: { value: "new" }, where: (existing) => existing.org.eq(PG.param.string("org")),
	}))).toBe("single-tenant")
})

it("does not accept OR, a different tenant, self-equality or a tenant-moving SET as proof", () => {
	for (const query of [
		insert.onConflictDoUpdate({ target: ["id"], set: { value: "new" }, where: (existing, excluded) => existing.org.eq(excluded.org).or(existing.value.eq("open")) }),
		insert.onConflictDoUpdate({ target: ["id"], set: { value: "new" }, where: (existing) => existing.org.eq("b") }),
		insert.onConflictDoUpdate({ target: ["id"], set: { value: "new" }, where: (existing) => existing.org.eq(existing.org) }),
		insert.onConflictDoUpdate({ target: ["org", "id"], set: { org: "b" } }),
	]) expect(scope(query)).toBe("cross-tenant")
	expect(scope(insert.onConflictDoNothing())).toBe("single-tenant")
	const declared = PG.compileUnsafe(insert.onConflictDoUpdate({ target: ["id"], set: { value: "new" } }).crossTenant(), { org: "a" })
	expect(declared.tenantScope).toBe("cross-tenant")
	expect(declared.crossTenantDeclared).toBe(true)
})

it.each(["excluded", "Excluded", "EXCLUDED", "app.excluded"])("does not confuse table %s with the excluded pseudo-table", (name) => {
	const named = PG.table(name, { columns: { id: PG.text, org: PG.text, value: PG.text }, primaryKey: ["id"], tenantColumn: "org" })
	const compiled = PG.compileUnsafe(PG.insertInto(named).values({ id: "same", org: "a", value: "new" }).onConflictDoUpdate({
		target: ["id"], set: { value: "new" }, where: (existing, excluded) => existing.org.eq(excluded.org),
	}))
	expect(compiled.tenantScope).toBe("cross-tenant")
})

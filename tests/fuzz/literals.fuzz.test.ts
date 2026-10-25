// Literal round-trip: any value of a column's type survives being written into SQL.
//
// For each column type, a random value reaches the database as JSON through
// the database's own parser — the reference row `v` — and, independently,
// through the builder along two paths:
//
//   compare  `WHERE v = <value>`      the literal a comparison writes
//   select   `SELECT <param> AS p`    a param in the SELECT list
//
// Each path must compile, run, and decode back to the value. They are separate
// properties so a bug on one cannot hide the other.
//
// What it catches: escaping (quotes, backslashes, placeholders inside values),
// numbers printed in a form the database reads differently, timestamps at the
// edges of a type's range, and nested arrays and maps.
import { afterAll, describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import type * as CH from "@maple-dev/effect-orm/clickhouse"
import { closeAll, dialects, type FuzzDialect } from "./dialects"
import { FuzzFailure, property, skip, skipKnown, withContext } from "./harness"
import { knownLiteralIssue, type LiteralPath } from "./known-issues"
import { normalize, referenceJson, wellFormed, type LiteralType } from "./values"

afterAll(closeAll)

const build = (dialect: FuzzDialect, literal: LiteralType, value: unknown, path: LiteralPath) => {
	const M = dialect.module
	const src = M.table("src", { external: true, columns: { v: literal.type } })
	const base = (M.from(src) as any).withCTE("src", literal.source(referenceJson(literal.wire(value)), value))
	if (path === "select") return base.select(($: any) => ({ v: $.v, p: M.param.of(literal.type, "p") }))
	return base.select(($: any) => ({ v: $.v })).where(($: any) => [value === null ? $.v.isNull() : $.v.eq(value)])
}

const roundTrip = async (dialect: FuzzDialect, literal: LiteralType, value: unknown, path: LiteralPath): Promise<void> => {
	// The reference row goes through JSON, which cannot carry a lone surrogate the way SQL text does.
	if (!wellFormed(value)) skip("lone surrogate")
	const known = knownLiteralIssue({ literal, value, path })
	if (known !== undefined) skipKnown(known)
	const exit = Effect.runSyncExit(dialect.module.compile(build(dialect, literal, value, path), { p: value }))
	if (Exit.isFailure(exit)) throw new FuzzFailure("the builder refused a valid value", { value, cause: String(exit.cause) })
	const compiled = exit.value as CH.CompiledQuery<any>
	const outcome = await dialect.targets[0]!.run(compiled)
	await withContext({ sql: compiled.sql, parameters: compiled.parameters, outcome }, () => {
		expect(outcome._tag).toBe("Rows")
		if (outcome._tag !== "Rows") return
		const expected = path === "select" ? { v: value, p: value } : { v: value }
		expect(normalize(outcome.rows)).toEqual([normalize(expected)])
	})
}

describe("literal round-trip", () => {
	for (const dialect of dialects) {
		for (const literal of dialect.literals) {
			for (const path of ["compare", "select"] as const) {
				if (path === "compare" && !literal.comparable) continue
				const name = `${literal.id} ${path}`
				it.skipIf(!dialect.targets[0]!.available)(name, () => property(name, literal.value, (value) => roundTrip(dialect, literal, value, path), { runs: 40 }), 120_000)
			}
		}
	}
})

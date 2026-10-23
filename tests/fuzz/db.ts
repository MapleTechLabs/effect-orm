// Run a compiled query on a real database and say what happened, without throwing.
//
// Oracles need to tell four outcomes apart — the builder refused, the database
// refused, the rows did not decode, or rows came back — so each is a tagged
// value rather than an exception the predicate would have to pick apart.
import { PGlite } from "@electric-sql/pglite"
import { Cause, Effect, Exit } from "effect"
import type * as CH from "@maple-dev/effect-orm/clickhouse"

export type Outcome =
	| { readonly _tag: "Rows"; readonly rows: ReadonlyArray<unknown>; readonly wire: ReadonlyArray<unknown> }
	| { readonly _tag: "DatabaseError"; readonly message: string; readonly wire?: undefined }
	| { readonly _tag: "DecodeError"; readonly message: string; readonly wire: ReadonlyArray<unknown> }

const decode = async (compiled: CH.CompiledQuery<any>, wire: ReadonlyArray<unknown>): Promise<Outcome> => {
	const exit = await Effect.runPromiseExit(compiled.decodeRows(wire as ReadonlyArray<Record<string, unknown>>))
	return Exit.isSuccess(exit)
		? { _tag: "Rows", rows: exit.value, wire }
		: { _tag: "DecodeError", message: Cause.pretty(exit.cause), wire }
}

// Postgres

let pglite: PGlite | undefined
/** One in-process Postgres per test file; PGlite takes the time zone from the host otherwise. */
export const postgres = (): PGlite => (pglite ??= new PGlite({ postgresqlconf: "timezone = 'UTC'" }))
export const closePostgres = async (): Promise<void> => {
	await pglite?.close()
	pglite = undefined
}

export const runPostgres = async (compiled: CH.CompiledQuery<any>): Promise<Outcome> => {
	let wire: ReadonlyArray<unknown>
	try {
		wire = (await postgres().query<Record<string, unknown>>(compiled.sql, [...compiled.parameters])).rows
	} catch (error) {
		return { _tag: "DatabaseError", message: error instanceof Error ? error.message : String(error) }
	}
	return decode(compiled, wire)
}

// ClickHouse

export const clickhouseEndpoint = process.env.EFFECT_ORM_CLICKHOUSE_URL
const user = process.env.EFFECT_ORM_CLICKHOUSE_USER ?? "default"
const password = process.env.EFFECT_ORM_CLICKHOUSE_PASSWORD ?? ""

/** POST raw SQL; the text reply, or the server's error. */
export const clickhouseText = async (
	sql: string,
	settings: Record<string, string> = {},
): Promise<{ readonly ok: boolean; readonly text: string }> => {
	const url = new URL(clickhouseEndpoint!)
	for (const [key, value] of Object.entries({ default_format: "JSONEachRow", session_timezone: "UTC", ...settings })) {
		url.searchParams.set(key, value)
	}
	// A soak sends tens of thousands of requests; a dropped socket is the harness's problem, not a finding.
	for (let attempt = 1; ; attempt++) {
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: { "X-ClickHouse-User": user, "X-ClickHouse-Key": password },
				body: sql,
				signal: AbortSignal.timeout(10_000),
			})
			return { ok: response.ok, text: await response.text() }
		} catch (error) {
			const code = (error as { cause?: { code?: string } }).cause?.code ?? String(error)
			if (attempt >= 5) throw new Error(`ClickHouse unreachable after ${attempt} attempts (${code}) — infrastructure, not a finding`)
			await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt))
		}
	}
}

export const runClickHouse = async (
	compiled: CH.CompiledQuery<any>,
	settings: Record<string, string> = {},
): Promise<Outcome> => {
	const { ok, text } = await clickhouseText(compiled.sql, settings)
	if (!ok) return { _tag: "DatabaseError", message: text.trim() }
	const wire = text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as unknown)
	return decode(compiled, wire)
}

/** What each fuzzed query runs on: Postgres always, ClickHouse when an endpoint is set. */
export type Target = "postgres" | "clickhouse" | "clickhouse-join-nulls"

export const run = (target: Target, compiled: CH.CompiledQuery<any>): Promise<Outcome> =>
	target === "postgres"
		? runPostgres(compiled)
		: runClickHouse(compiled, {
				join_use_nulls: target === "clickhouse-join-nulls" ? "1" : "0",
				output_format_json_quote_64bit_integers: target === "clickhouse-join-nulls" ? "1" : "0",
			})

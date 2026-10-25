// Raw SQLite and D1 connections for the core suite and the fuzzer: no Effect
// SqlClient in between, so what the database returns is what the query decodes.
import { DatabaseSync } from "node:sqlite"
import { Miniflare } from "miniflare"

/**
 * Retry what failed to reach workerd ("fetch failed": a dropped local socket
 * under a soak's load), as the ClickHouse helper retries a dropped request. A
 * database error is not retried: it reached the database and is the finding.
 */
export const retryTransport = async <A>(run: () => Promise<A>): Promise<A> => {
	for (let attempt = 1; ; attempt++) {
		try {
			return await run()
		} catch (error) {
			const message = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error)
			if (attempt >= 5 || !/fetch failed|ECONNRESET|ECONNREFUSED|socket hang up/.test(message)) throw error
			await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt))
		}
	}
}

export type RawQuery = (sql: string, parameters: ReadonlyArray<unknown>) => Promise<ReadonlyArray<Record<string, unknown>>>

/** An in-memory SQLite (Node's built-in driver, the one `@effect/sql-sqlite-node` uses). */
export const sqliteDatabase = (): { readonly query: RawQuery; readonly close: () => Promise<void> } => {
	const db = new DatabaseSync(":memory:")
	return {
		// node:sqlite rows have a null prototype; spread them so `toEqual` compares plain objects.
		query: async (sql, parameters) => db.prepare(sql).all(...(parameters as Array<any>)).map((row) => ({ ...row })),
		close: async () => db.close(),
	}
}

/** A local D1 database in workerd, through the Workers binding an application gets. */
export const d1Database = (): { readonly query: RawQuery; readonly close: () => Promise<void> } => {
	let started: Promise<{ readonly mf: Miniflare; readonly db: D1DatabaseLike }> | undefined
	const start = () =>
		(started ??= (async () => {
			const mf = new Miniflare({
				modules: true,
				script: "export default { fetch() { return new Response('fuzz') } }",
				compatibilityDate: "2026-07-01",
				d1Databases: ["DB"],
			})
			return { mf, db: (await mf.getD1Database("DB")) as unknown as D1DatabaseLike }
		})())
	return {
		query: async (sql, parameters) => {
			const { db } = await start()
			return retryTransport(async () => (await db.prepare(sql).bind(...parameters).all()).results)
		},
		close: async () => {
			if (started !== undefined) await (await started).mf.dispose()
			started = undefined
		},
	}
}

interface D1DatabaseLike {
	prepare(sql: string): { bind(...values: ReadonlyArray<unknown>): { all(): Promise<{ results: Array<Record<string, unknown>> }> } }
}

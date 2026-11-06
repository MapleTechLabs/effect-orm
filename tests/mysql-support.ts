// Raw MySQL and MariaDB connections for the core suite and the fuzzer: mysql2
// with no Effect SqlClient in between, configured as docs/mysql.md tells an
// application to (UTC, `supportBigNumbers`), and statements sent prepared, as
// `@effect/sql-mysql2` sends them by default, or over the text protocol, as it
// does with `disablePreparedStatements` (Cloudflare Hyperdrive). Live only when
// EFFECT_ORM_MYSQL_URL / EFFECT_ORM_MARIADB_URL are set.
import mysql from "mysql2/promise"

export type RawQuery = (sql: string, parameters: ReadonlyArray<unknown>) => Promise<ReadonlyArray<Record<string, unknown>>>

export interface MysqlServer {
	readonly name: "mysql" | "mariadb"
	readonly url: string | undefined
	/**
	 * A case-sensitive collation without PAD SPACE, so text compares by code
	 * point as on the other dialects ('a' <> 'A', 'a' <> 'a '). docs/mysql.md.
	 */
	readonly collation: string
}

export const mysqlServer: MysqlServer = { name: "mysql", url: process.env.EFFECT_ORM_MYSQL_URL, collation: "utf8mb4_0900_bin" }
export const mariadbServer: MysqlServer = { name: "mariadb", url: process.env.EFFECT_ORM_MARIADB_URL, collation: "utf8mb4_nopad_bin" }

export const mysqlDatabase = (
	server: MysqlServer,
	protocol: "prepared" | "text" = "prepared",
): { readonly query: RawQuery; readonly close: () => Promise<void> } => {
	let started: Promise<mysql.Connection> | undefined
	const start = () =>
		(started ??= (async () => {
			const connection = await mysql.createConnection({
				uri: server.url!,
				timezone: "Z",
				supportBigNumbers: true,
				// The server allows ~16k prepared statements in all; a soak sends far more distinct ones.
				maxPreparedStatements: 64,
			})
			await connection.query(`SET NAMES utf8mb4 COLLATE ${server.collation}`)
			await connection.query("SET time_zone = '+00:00'")
			return connection
		})())
	return {
		query: async (sql, parameters) => {
			const connection = await start()
			// The text protocol has mysql2 write each value into the SQL, escaped, as the Effect client's `query` path does.
			const [rows] = protocol === "prepared" ? await connection.execute(sql, parameters as Array<any>) : await connection.query(sql, parameters as Array<any>)
			return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : []
		},
		close: async () => {
			if (started !== undefined) await (await started).end()
			started = undefined
		},
	}
}

/** A database of its own, created as root (the test user may not CREATE DATABASE) and dropped on `close`. */
export interface ScratchDatabase {
	readonly name: string
	/** Statements over the text protocol, so DDL and multi-row reads need no prepared statement. */
	readonly query: RawQuery
	/** Drop every table: drop the database and create it again. */
	readonly reset: () => Promise<void>
	readonly close: () => Promise<void>
}

let scratchCount = 0

/**
 * A throwaway database on `server`, `<prefix>_<pid>_<n>`, reached as `root`
 * with the URL's password (the CI and local containers share one).
 */
export const scratchDatabase = async (server: MysqlServer, prefix: string): Promise<ScratchDatabase> => {
	const url = new URL(server.url!)
	url.username = "root"
	const name = `${prefix}_${process.pid}_${++scratchCount}`
	const connection = await mysql.createConnection({ uri: url.toString(), timezone: "Z", supportBigNumbers: true })
	await connection.query("SET time_zone = '+00:00'")
	const create = async () => {
		await connection.query(`DROP DATABASE IF EXISTS \`${name}\``)
		await connection.query(`CREATE DATABASE \`${name}\``)
		await connection.query(`USE \`${name}\``)
	}
	await create()
	return {
		name,
		query: async (sql, parameters) => {
			const [rows] = await connection.query(sql, parameters as Array<any>)
			return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : []
		},
		reset: create,
		close: async () => {
			try {
				await connection.query(`DROP DATABASE IF EXISTS \`${name}\``)
			} finally {
				await connection.end()
			}
		},
	}
}

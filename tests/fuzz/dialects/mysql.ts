// MySQL 8.4 and MariaDB 11.4: live only when EFFECT_ORM_MYSQL_URL /
// EFFECT_ORM_MARIADB_URL are set. Both run MySQL's SQL through mysql2 with a
// case-sensitive, no-pad collation (see ../../mysql-support.ts), so text
// compares by code point as on the other targets.
import fc from "fast-check"
import { Arbitrary, Schema } from "effect"
import * as MySQL from "@maple-dev/effect-orm/mysql"
import { mariadbContext, mysqlContext } from "../../core-cases"
import { mariadbServer, mysqlDatabase, mysqlServer, type MysqlServer } from "../../mysql-support"
import { dateTimeWire, exactDouble, finite, int32, jsonPayload, jsonPayloadSchema, nastyString, nullOr, utc, type LiteralType } from "../values"
import { runWith, type DialectModule, type FuzzDialect, type Semantics, type StringRules, type WriteSupport } from "./types"

const semantics: Semantics = {
	missingJoinColumn: "null",
	// `/` is DECIMAL division: four places past the dividend's, nine kept internally.
	integerDivision: "decimal",
	// MOD truncates towards zero, as JS `%` does, on integers and on DECIMALs.
	quotients: "internal",
	modulo: "truncate",
	// NULL is MySQL's smallest value.
	nulls: { asc: "first", desc: "last" },
	emptyAggregate: "null",
	// Under the binary collation the targets use (docs/mysql.md).
	likeIgnoresCase: false,
}

// Literals

const strings: StringRules = { nul: true, leadingBom: true }
const MIN_DT = Date.UTC(1000, 0, 1)
const MAX_DT = Date.UTC(9999, 11, 31, 23, 59, 59, 999)

/** A MySQL string literal for raw reference SQL: the server reads `\` as an escape. */
const sqlText = (text: string) => `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\0/g, "\\0")}'`

/** The reference row, read from JSON by the server's own JSON functions rather than written by the builder. */
const jsonSource = (read: (extracted: string) => string) => (json: string) =>
	`SELECT ${read(`JSON_EXTRACT(${sqlText(json)}, '$.v')`)} AS \`v\``
const unquoted = (cast: string) => jsonSource((v) => `CAST(JSON_UNQUOTE(${v}) AS ${cast})`)

/** A JSON null as a typed SQL NULL (JSON_UNQUOTE of one is the text `null`). */
const orNull = (source: (json: string) => string, cast: string) => (json: string, value: unknown) =>
	value === null ? `SELECT CAST(NULL AS ${cast}) AS \`v\`` : source(json)

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
/** DECIMAL(18,4) text as MySQL prints it: always four places. */
const decimalText = fc.bigInt({ min: -(10n ** 18n) + 1n, max: 10n ** 18n - 1n }).map((mantissa) => {
	const sign = mantissa < 0n ? "-" : ""
	const digits = (mantissa < 0n ? -mantissa : mantissa).toString().padStart(5, "0")
	return `${sign}${digits.slice(0, -4)}.${digits.slice(-4)}`
})
const dateText = fc.integer({ min: MIN_DT, max: Date.UTC(9999, 11, 31) }).map((ms) => new Date(ms).toISOString().slice(0, 10))

/**
 * MySQL's JSON parser reads a double up to one ULP off (`7.33277286497045e+62`
 * comes back `…044e+62`), on every path: a JSON column, CAST, JSON_EXTRACT.
 * The server's limit, not the builder's: JSON numbers compare at 12 significant digits, and a tiny double can be several ULPs off.
 */
const jsonAt12Digits = (value: unknown): unknown => {
	if (value === null || typeof value !== "object" || !("values" in value)) return value
	const payload = value as { values: ReadonlyArray<number | null> }
	return { ...payload, values: payload.values.map((n) => (n === null ? n : Number(n.toPrecision(12)))) }
}

/**
 * mysql2 with `supportBigNumbers` (as `@effect/sql-mysql2` sets it) reads a
 * JSON integer past 2^53 as a string, so a payload number decoded as `number`
 * must be below it (docs/mysql.md). Every double from 2^53 up is such an integer.
 */
const jsonDriverNumbers = jsonPayload(strings).pipe(
	Arbitrary.filter((payload) => payload.values.every((n) => n === null || Math.abs(n) < 2 ** 53)),
)

const literals = (dialect: string): ReadonlyArray<LiteralType> => {
	const nasty = nastyString(strings)
	const literal = (
		id: string,
		type: MySQL.MysqlType<string, any, any>,
		value: LiteralType["value"],
		source: (json: string, value: unknown) => string,
		options: { wire?: (value: unknown) => unknown; comparable?: boolean; normalizeValue?: (value: unknown) => unknown } = {},
	): LiteralType => ({
		id: `${dialect}:${id}`,
		type,
		value,
		wire: options.wire ?? ((v) => v),
		source,
		comparable: options.comparable ?? true,
		normalizeValue: options.normalizeValue,
	})
	const text = unquoted("CHAR")
	const signed = unquoted("SIGNED")
	return [
		literal("text", MySQL.text, nasty, text),
		literal("longtext", MySQL.longtext, nasty, text),
		literal("varchar(64)", MySQL.varchar(64), nasty, text),
		literal("brand(text)", MySQL.brand(MySQL.text, Schema.String.pipe(Schema.brand("FuzzText"))), nasty, text),
		literal("custom(int)", MySQL.custom("int", MySQL.int.schema), int32, signed),
		literal("tinyint", MySQL.tinyint, fc.integer({ min: -128, max: 127 }), signed),
		literal("smallint", MySQL.smallint, fc.integer({ min: -32768, max: 32767 }), signed),
		literal("int", MySQL.int, int32, signed),
		literal("int unsigned", MySQL.intUnsigned, fc.nat({ max: 2 ** 32 - 1 }), unquoted("UNSIGNED")),
		literal("bigint", MySQL.bigint, fc.maxSafeInteger(), signed),
		// MySQL's JSON parser reads some doubles one ULP off; the reference is built from the bits.
		literal("double", MySQL.double, finite, (_, v) => `SELECT ${exactDouble(v as number, "DOUBLE")} AS \`v\``),
		literal("decimal(18,4)", MySQL.decimal(18, 4), decimalText, unquoted("DECIMAL(18,4)"), { wire: (v) => v }),
		// The reference value is 0/1, the integer MySQL stores for a boolean.
		literal("boolean", MySQL.boolean, Arbitrary.schema(Schema.Boolean), signed, { wire: (v) => (v ? 1 : 0) }),
		literal("datetime(3)", MySQL.datetime, fc.integer({ min: MIN_DT, max: MAX_DT }).map(utc), unquoted("DATETIME(3)"), { wire: dateTimeWire(true) }),
		literal("date", MySQL.date, dateText, unquoted("DATE")),
		literal("blob", MySQL.blob, fc.uint8Array({ maxLength: 8 }), jsonSource((v) => `UNHEX(JSON_UNQUOTE(${v}))`), { wire: (v) => hex(v as Uint8Array) }),
		literal("json", MySQL.json(jsonPayloadSchema), jsonDriverNumbers, jsonSource((v) => v), {
			comparable: false,
			normalizeValue: dialect === "mysql" ? jsonAt12Digits : undefined,
		}),
		literal("nullable(text)", MySQL.nullable(MySQL.text), nullOr(nasty), orNull(text, "CHAR")),
		literal("nullable(bigint)", MySQL.nullable(MySQL.bigint), nullOr(fc.maxSafeInteger()), orNull(signed, "SIGNED")),
	]
}

/** The query-table form the suites call (`{ external: true, columns }`), on `/mysql`'s `table`. */
const module = (dialect: MySQL.Dialect<"mysql">): DialectModule => ({
	...(MySQL as never as DialectModule),
	table: (name, definition) => MySQL.table(name, definition.columns, { tenantColumn: definition.tenantColumn }) as never,
	compile: (query, params) => MySQL.compile(query, params, { dialect }),
	compileUnion: (union, params) => MySQL.compileUnion(union, params, { dialect }),
})

const writes = (server: MysqlServer, exec: (sql: string) => Promise<unknown>): WriteSupport => ({
	insertSelect: true,
	update: true,
	delete: true,
	onConflict: false,
	returning: false,
	defaultCells: true,
	scratch: {
		table: (name) =>
			MySQL.table(name, { Id: MySQL.bigint, OrgId: MySQL.text, Name: MySQL.text, Note: MySQL.nullable(MySQL.text), Qty: MySQL.bigint }, { defaults: ["Qty"] }),
		create: (name) => [
			`CREATE TABLE \`${name}\` (\`Id\` bigint PRIMARY KEY, \`OrgId\` text NOT NULL, \`Name\` text NOT NULL, \`Note\` text, \`Qty\` bigint NOT NULL DEFAULT 5) DEFAULT CHARSET = utf8mb4 COLLATE = ${server.collation}`,
		],
		drop: (name) => `DROP TABLE IF EXISTS \`${name}\``,
		exec: async (sql) => {
			await exec(sql)
		},
	},
})

const fuzzDialect = (server: MysqlServer, dialect: MySQL.Dialect<"mysql">, context: typeof mysqlContext): FuzzDialect => {
	const db = mysqlDatabase(server)
	const text = mysqlDatabase(server, "text")
	return {
		name: server.name,
		module: module(dialect),
		context,
		strings,
		ilike: false,
		checkPlaceholders: (sql, count) => {
			const used = sql.split("?").length - 1
			return used === count ? undefined : `${used} placeholders for ${count} parameters`
		},
		literals: literals(server.name),
		writes: writes(server, (sql) => db.query(sql, [])),
		targets: [
			{ name: server.name, available: server.url !== undefined, semantics, run: (compiled) => runWith(compiled, db.query) },
			// `disablePreparedStatements`, as Cloudflare Hyperdrive needs: mysql2 writes the values into the SQL.
			{ name: `${server.name}-text`, available: server.url !== undefined, semantics, run: (compiled) => runWith(compiled, text.query) },
		],
		close: async () => {
			await Promise.all([db.close(), text.close()])
		},
	}
}

export const mysql = fuzzDialect(mysqlServer, MySQL.mysqlDialect, mysqlContext)
export const mariadb = fuzzDialect(mariadbServer, MySQL.mariadbDialect, mariadbContext)

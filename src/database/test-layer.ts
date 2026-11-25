// A `Database` for unit tests: no server, no module mocks.
//
// It is the real `fromSqlClient` over a fake `SqlClient`. The fake records
// each statement and answers with rows the test gives, so compiling, row
// decoding, tenant-scope checks and transaction handling all run as they do
// against a database. Only the server is replaced. See docs/testing.md.

import { Context, Effect, Layer, Ref, Stream } from "effect"
import * as Reactivity from "effect/reactivity/Reactivity"
import * as SqlClient from "effect/sql/SqlClient"
import type { Connection } from "effect/sql/SqlConnection"
import type { SqlError } from "effect/sql/SqlError"
import * as SqlStatement from "effect/sql/Statement"
import type { Dialect } from "../ch/dialect"
import { Database, fromSqlClient } from "./database"

/** A statement as the fake database received it. */
export interface TestStatement {
	readonly sql: string
	readonly parameters: ReadonlyArray<unknown>
}

/**
 * What a write reports, as `runWrite` reads it. Queue it for a `runWrite`;
 * `run` and `execute` read it as no rows.
 */
export interface TestWriteReply {
	readonly affectedRows: number
	readonly insertId?: number | undefined
}

/**
 * The answer to one statement: rows as the server would send them (before
 * decoding), what a write did, or the driver error it would fail with.
 */
export type TestReply = ReadonlyArray<Record<string, unknown>> | TestWriteReply | SqlError

export interface TestDatabaseOptions {
	/** The dialect to compile for: `postgresDialect`, `clickhouseDialect`, `sqliteDialect` or `d1Dialect`. */
	readonly dialect: Dialect
	/** The answer when no reply is queued. Default: no rows. */
	readonly respond?: (statement: TestStatement) => TestReply
	/** As on `fromSqlClient`. */
	readonly requireTenantScope?: boolean
}

export interface TestDatabaseApi {
	/**
	 * Every statement received, in order. Transaction control (`BEGIN`,
	 * `COMMIT`, `ROLLBACK`, savepoints) is included.
	 */
	readonly statements: Effect.Effect<ReadonlyArray<TestStatement>>
	/** Queue answers for the next statements, one each, in order. Transaction control takes none. */
	readonly reply: (...replies: ReadonlyArray<TestReply>) => Effect.Effect<void>
	/** Forget the recorded statements and the queued replies. */
	readonly reset: Effect.Effect<void>
}

/** The control side of `layerTest`: what was sent, and what to answer. */
export class TestDatabase extends Context.Service<TestDatabase, TestDatabaseApi>()("@maple-dev/effect-orm/TestDatabase") {}

const isRows = (reply: TestReply): reply is ReadonlyArray<Record<string, unknown>> => Array.isArray(reply)

const isWrite = (reply: TestReply): reply is TestWriteReply =>
	!Array.isArray(reply) && typeof (reply as Partial<TestWriteReply>).affectedRows === "number"

// Placeholders are already in the SQL `Database` sends; this compiler only has
// to pass that SQL and its parameters through.
const compiler = SqlStatement.makeCompiler({
	dialect: "pg",
	placeholder: (i) => `$${i}`,
	onIdentifier: SqlStatement.defaultEscape('"'),
	onRecordUpdate: () => ["", []],
	onCustom: () => ["", []],
})

/** The fake database and its control side, without a layer. */
const makeTest = (
	options: TestDatabaseOptions,
): Effect.Effect<{ readonly database: Database["Service"]; readonly test: TestDatabaseApi }> =>
	Effect.gen(function* () {
		const sent = yield* Ref.make<ReadonlyArray<TestStatement>>([])
		const queued = yield* Ref.make<ReadonlyArray<TestReply>>([])
		const respond = options.respond ?? (() => [])

		const record = (sql: string, parameters: ReadonlyArray<unknown>) => {
			const statement: TestStatement = { sql, parameters: [...parameters] }
			return Effect.as(Ref.update(sent, (all) => [...all, statement]), statement)
		}

		const next = (sql: string, parameters: ReadonlyArray<unknown>): Effect.Effect<TestReply> =>
			Effect.flatMap(record(sql, parameters), (statement) =>
				Effect.map(
					Ref.modify(queued, (replies): readonly [TestReply | undefined, ReadonlyArray<TestReply>] => [
						replies[0],
						replies.slice(1),
					]),
					(queuedReply) => queuedReply ?? respond(statement),
				),
			)

		const answer = (sql: string, parameters: ReadonlyArray<unknown>): Effect.Effect<ReadonlyArray<any>, SqlError> =>
			Effect.flatMap(next(sql, parameters), (reply) =>
				isRows(reply) ? Effect.succeed(reply) : isWrite(reply) ? Effect.succeed([]) : Effect.fail(reply),
			)

		// `runWrite` reads the raw result: a write reply in mysql2's shape, and rows
		// (the default reply is none) as a write that changed nothing.
		const answerRaw = (sql: string, parameters: ReadonlyArray<unknown>): Effect.Effect<unknown, SqlError> =>
			Effect.flatMap(next(sql, parameters), (reply) =>
				isRows(reply)
					? reply.length === 0
						? Effect.succeed({ affectedRows: 0 })
						: Effect.die(new Error("layerTest: runWrite was answered with rows; queue a TestWriteReply ({ affectedRows, insertId? }) for it"))
					: isWrite(reply)
						? Effect.succeed({ affectedRows: reply.affectedRows, insertId: reply.insertId ?? 0 })
						: Effect.fail(reply),
			)

		// Transaction control runs unprepared; it is recorded and always succeeds.
		const control = (sql: string, parameters: ReadonlyArray<unknown>) => Effect.as(record(sql, parameters), [])

		const values = (sql: string, parameters: ReadonlyArray<unknown>) =>
			Effect.map(answer(sql, parameters), (rows) => rows.map((row) => Object.values(row)))

		const connection: Connection = {
			execute: (sql, parameters, transformRows) =>
				transformRows ? Effect.map(answer(sql, parameters), transformRows) : answer(sql, parameters),
			executeRaw: answerRaw,
			executeValues: values,
			executeValuesUnprepared: values,
			executeUnprepared: control,
			executeStream: (sql, parameters, transformRows) =>
				Stream.fromIterableEffect(
					transformRows ? Effect.map(answer(sql, parameters), transformRows) : answer(sql, parameters),
				),
		}

		const client = yield* SqlClient.make({
			acquirer: Effect.succeed(connection),
			compiler,
			driver: "effect-orm-test",
			// `Database` names the system on its own span.
			spanAttributes: [],
		}).pipe(Effect.provide(Reactivity.layer))

		const database = fromSqlClient(client, {
			dialect: options.dialect,
			...(options.requireTenantScope === undefined ? undefined : { requireTenantScope: options.requireTenantScope }),
		})

		const test: TestDatabaseApi = {
			statements: Ref.get(sent),
			reply: (...replies) => Ref.update(queued, (all) => [...all, ...replies]),
			reset: Effect.andThen(Ref.set(sent, []), Ref.set(queued, [])),
		}
		return { database, test }
	})

/**
 * A `Database` with no server, for unit tests, and the `TestDatabase` that
 * controls it. Each statement is recorded and answered with the next queued
 * reply, or with `respond`. Rows are decoded by the query's own row schema.
 */
export const layerTest = (options: TestDatabaseOptions): Layer.Layer<Database | TestDatabase> =>
	Layer.effectContext(
		Effect.map(makeTest(options), ({ database, test }) => Context.make(Database, database).pipe(Context.add(TestDatabase, test))),
	)

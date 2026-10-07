import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as CH from "../clickhouse"
import { fromRecord, type MigrationInput } from "../migrate/source"
import * as S from "../schema"
import { analyze } from "./graph"

const table = (name: string, extra: Record<string, CH.ColumnInput> = {}) =>
	CH.table(name, { columns: { Id: CH.string, ...extra }, engine: CH.engine.mergeTree(), orderBy: ["Id"] })

const input = (objects: ReadonlyArray<S.SchemaObject>, prevIds: ReadonlyArray<string>) =>
	Effect.map(Effect.flatMap(S.entitiesOf(objects), (entities) => S.makeSnapshot(entities, prevIds)), (snapshot) => ({
		snapshot,
		input: { kind: "ops", migration: '{"version":"1","ops":[]}', snapshot: S.serializeSnapshot(snapshot) } satisfies MigrationInput,
	}))

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect)

describe("analyze", () => {
	it("merges branches that touch different tables", async () => {
		const result = await run(
			Effect.gen(function* () {
				const root = yield* input([table("a")], [S.ORIGIN_ID])
				const left = yield* input([table("a"), table("b")], [root.snapshot.id])
				const right = yield* input([table("a"), table("c")], [root.snapshot.id])
				return yield* analyze(
					yield* fromRecord({ "20260101000000_root": root.input, "20260102000000_left": left.input, "20260102000001_right": right.input }),
				)
			}),
		)
		expect(result.problems).toEqual([])
		expect(result.leaves.map((l) => l.name)).toEqual(["20260102000000_left", "20260102000001_right"])
		expect(result.baseIds).toHaveLength(2)
		expect(result.base.filter((e) => e.kind === "table").map((e) => e.name).sort()).toEqual(["a", "b", "c"])
	})

	it("reports branches that change the same table", async () => {
		const result = await run(
			Effect.gen(function* () {
				const root = yield* input([table("a")], [S.ORIGIN_ID])
				const left = yield* input([table("a", { X: CH.string })], [root.snapshot.id])
				const right = yield* input([table("a", { Y: CH.string })], [root.snapshot.id])
				return yield* analyze(
					yield* fromRecord({ "20260101000000_root": root.input, "20260102000000_left": left.input, "20260102000001_right": right.input }),
				)
			}),
		)
		expect(result.problems).toEqual([
			expect.objectContaining({ migration: "20260102000001_right", message: expect.stringContaining("both change table a") }),
		])
	})

	it("reports a migration that sorts before its parent", async () => {
		const result = await run(
			Effect.gen(function* () {
				const root = yield* input([table("a")], [S.ORIGIN_ID])
				const child = yield* input([table("a"), table("b")], [root.snapshot.id])
				return yield* analyze(yield* fromRecord({ "20260102000000_root": root.input, "20260101000000_child": child.input }))
			}),
		)
		expect(result.problems).toEqual([
			expect.objectContaining({ migration: "20260101000000_child", message: expect.stringContaining("sorts before its parent") }),
		])
	})
})

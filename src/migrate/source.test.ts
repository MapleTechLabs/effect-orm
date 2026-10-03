import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { fromFileSystem } from "./source"

describe("fromFileSystem", () => {
	const dir = mkdtempSync(join(tmpdir(), "effect-orm-source-"))
	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	it("reads migration folders and skips files and staging folders beside them", async () => {
		mkdirSync(join(dir, "20260101000000_init"))
		writeFileSync(join(dir, "20260101000000_init", "migration.sql"), "SELECT 1\n--> statement-breakpoint\nSELECT 2")
		mkdirSync(join(dir, "20260102000000_half.tmp-123"))
		writeFileSync(join(dir, "20260102000000_half.tmp-123", "migration.sql"), "SELECT 3")
		writeFileSync(join(dir, "README.md"), "notes")
		const migrations = await Effect.runPromise(fromFileSystem(dir).pipe(Effect.provide(BunServices.layer)))
		expect(migrations.map((m) => [m.name, m.sql])).toEqual([["20260101000000_init", ["SELECT 1", "SELECT 2"]]])
	})
})

import { resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { Effect, Schema } from "effect"
import { readFile } from "node:fs/promises"
import * as Migrate from "../migrate"
import { Hints, type Hint } from "../schema/diff"
import { check, generate, KitError, readMigrations, type KitConfig } from "./generate"

const help = `effect-orm: schema migrations for ClickHouse and Postgres

  generate [--name x] [--custom]   Diff the schema against the migrations folder and write the next migration
           [--hints <json>] [--hints-file <path>]
           [--baseline [--from-drizzle]]  Start the history of a folder another tool wrote: a migration that runs
                                   nothing, with the current schema (or drizzle-kit's last snapshot) as its snapshot
  check                            Validate the migrations folder (snapshot chain, branch conflicts)
  migrate [--strict]               Apply pending migrations (needs config.driver)
  status                           Applied, pending, partial, or changed, per migration
  verify                           Compare the database with the last applied snapshot
  baseline <migration>             Record <migration> and every one before it as applied, without running them
  resolve <migration> <step>       Record what a step left "started" did, after checking the database:
          --ran | --not-ran        --ran skips it on the next migrate, --not-ran runs it

  --config <path>                  Default: effect-orm.config.ts
  --json                           Machine-readable output

Exit codes: 0 ok, 1 error, 2 missing hints (confirm data loss), 3 drift found.`

const options = {
	config: { type: "string" },
	name: { type: "string" },
	custom: { type: "boolean" },
	baseline: { type: "boolean" },
	"from-drizzle": { type: "boolean" },
	hints: { type: "string" },
	"hints-file": { type: "string" },
	strict: { type: "boolean" },
	ran: { type: "boolean" },
	"not-ran": { type: "boolean" },
	json: { type: "boolean" },
	help: { type: "boolean" },
} as const

const decodeHints = Schema.decodeUnknownEffect(Schema.fromJsonString(Hints))

const loadConfig = (path: string) =>
	Effect.tryPromise({
		try: () => import(pathToFileURL(path).href) as Promise<{ default?: KitConfig }>,
		catch: (cause) => new KitError({ code: "config", message: `Cannot import ${path}: ${cause instanceof Error ? cause.message : String(cause)}` }),
	}).pipe(
		Effect.flatMap((module) =>
			module.default === undefined
				? Effect.fail(new KitError({ code: "config", message: `${path} has no default export; export defineConfig({ ... })` }))
				: Effect.succeed(module.default),
		),
	)

const promptConfirm = (hint: Hint): Effect.Effect<boolean> =>
	Effect.promise(async () => {
		const rl = createInterface({ input: process.stdin, output: process.stdout })
		const answer = await rl.question(`Drop ${hint.kind} ${hint.entity}? Its data will be lost. [y/N] `)
		rl.close()
		return /^y(es)?$/i.test(answer.trim())
	})

const withDriver = <A, E>(config: KitConfig, body: Effect.Effect<A, E, Migrate.MigrationDriver>) =>
	config.driver === undefined
		? Effect.fail(new KitError({ code: "config", message: "this command needs a database: set `driver` in the config" }))
		: body.pipe(Effect.provide(config.driver))

const program = (args: ReadonlyArray<string>, print: (line: string) => void) =>
	Effect.gen(function* () {
		const parsed = yield* Effect.try({
			try: () => parseArgs({ args: [...args], options, allowPositionals: true }),
			catch: (cause) => new KitError({ code: "config", message: cause instanceof Error ? cause.message : String(cause) }),
		})
		const [command] = parsed.positionals
		if (parsed.values.help === true || command === undefined) {
			print(help)
			return 0
		}
		const cwd = process.cwd()
		const config = yield* loadConfig(resolve(cwd, parsed.values.config ?? "effect-orm.config.ts"))
		const json = parsed.values.json === true
		const out = (value: unknown, text: () => ReadonlyArray<string>) => {
			if (json) print(JSON.stringify(value))
			else for (const line of text()) print(line)
		}

		switch (command) {
			case "generate": {
				const fromFile = parsed.values["hints-file"]
				const rawHints =
					parsed.values.hints ??
					(fromFile === undefined ? undefined : yield* Effect.tryPromise({ try: () => readFile(resolve(cwd, fromFile), "utf8"), catch: () => new KitError({ code: "io", message: `Cannot read ${fromFile}` }) }))
				const hints = rawHints === undefined ? [] : yield* decodeHints(rawHints).pipe(Effect.mapError(() => new KitError({ code: "config", message: "--hints must be a JSON array of hints" })))
				const interactive = !json && process.stdin.isTTY === true
				const result = yield* generate(config, cwd, {
					hints,
					...(parsed.values.name !== undefined ? { name: parsed.values.name } : undefined),
					...(parsed.values.custom === true ? { custom: true } : undefined),
					...(parsed.values.baseline === true ? { baseline: parsed.values["from-drizzle"] === true ? "drizzle" : "schema" } : undefined),
					...(interactive ? { confirm: promptConfirm } : undefined),
				})
				out(result, () =>
					result.written === undefined
						? ["No schema changes, nothing to write."]
						: [`Wrote ${result.written}`, ...result.plan.flatMap((step) => step.sql.map((sql) => `  [${step.label}] ${sql.replace(/\n/g, "\n    ")}`))],
				)
				return 0
			}
			case "check": {
				const result = yield* check(config, cwd)
				out(result, () => [
					`${result.migrations} migrations, ok.${result.legacy > 0 ? ` ${result.legacy} predate the first snapshot.` : ""}`,
					...(result.leaves.length > 1 ? [`Independent branches (merged by the next generate): ${result.leaves.join(", ")}`] : []),
				])
				return 0
			}
			case "resolve": {
				const [, migrationName, stepId] = parsed.positionals
				const ran = parsed.values.ran === true
				const notRan = parsed.values["not-ran"] === true
				if (migrationName === undefined || stepId === undefined || ran === notRan) {
					return yield* new KitError({ code: "config", message: "usage: effect-orm resolve <migration> <step> --ran | --not-ran" })
				}
				const migrations = yield* readMigrations(resolve(cwd, config.out))
				const migration = migrations.find((m) => m.name === migrationName)
				if (migration === undefined) return yield* new KitError({ code: "config", message: `no migration named ${migrationName}` })
				yield* withDriver(
					config,
					Migrate.resolveStep({
						migration,
						step: stepId,
						outcome: ran ? "ran" : "not-ran",
						render: config.render ?? {},
						...(config.dialect !== undefined ? { dialect: config.dialect } : undefined),
					}),
				)
				out({ migration: migrationName, step: stepId, outcome: ran ? "ran" : "not-ran" }, () => [
					`Recorded ${migrationName} step ${stepId} as ${ran ? "done; migrate will skip it" : "not run; migrate will run it"}.`,
				])
				return 0
			}
			case "baseline": {
				const [, upTo] = parsed.positionals
				if (upTo === undefined) return yield* new KitError({ code: "config", message: "usage: effect-orm baseline <migration>" })
				const migrations = yield* readMigrations(resolve(cwd, config.out))
				const recorded = yield* withDriver(
					config,
					Migrate.baseline({
						migrations,
						upTo,
						render: config.render ?? {},
						...(config.dialect !== undefined ? { dialect: config.dialect } : undefined),
					}),
				)
				out(recorded, () => (recorded.length === 0 ? ["Already recorded; nothing to do."] : recorded.map((name) => `recorded ${name} as applied`)))
				return 0
			}
			case "migrate":
			case "status":
			case "verify": {
				const migrations = yield* readMigrations(resolve(cwd, config.out))
				const render = config.render ?? {}
				const dialect = config.dialect !== undefined ? { dialect: config.dialect } : undefined
				if (command === "migrate") {
					const ran = yield* withDriver(config, Migrate.run({ migrations, render, strict: parsed.values.strict === true, ...dialect }))
					out(ran, () => (ran.length === 0 ? ["Nothing to apply."] : ran.map((m) => `applied ${m.name} (${m.steps} statements${m.resumedSteps > 0 ? `, ${m.resumedSteps} resumed` : ""})`)))
					return 0
				}
				if (command === "status") {
					const rows = yield* withDriver(config, Migrate.status(migrations, render, config.dialect))
					out(rows, () => rows.map((r) => `${r.state.padEnd(8)} ${r.name}${r.appliedAt !== undefined ? `  ${r.appliedAt}` : ""}`))
					return 0
				}
				const result = yield* withDriver(config, Migrate.verify(migrations, { ...dialect }))
				out(result, () =>
					result.against === undefined
						? ["No applied migration with a snapshot to compare against."]
						: result.drift.length === 0
							? [`No drift against ${result.against}.`]
							: [`Drift against ${result.against}:`, ...result.drift.map((d) => `  ${d.entity}: ${d.problem}${d.expected !== undefined || d.actual !== undefined ? ` (expected ${d.expected ?? "-"}, actual ${d.actual ?? "-"})` : ""}`)],
				)
				return result.drift.length === 0 ? 0 : 3
			}
			default:
				print(help)
				return 1
		}
	})

/** Runs the CLI and returns its exit code. */
export const runCli = (args: ReadonlyArray<string>, print: (line: string) => void = (line) => console.log(line)): Promise<number> =>
	Effect.runPromise(
		program(args, print).pipe(
			Effect.catch((error: unknown) =>
				Effect.sync(() => {
					if (error instanceof KitError) {
						console.error(`effect-orm: ${error.message}`)
						for (const line of error.details ?? []) console.error(`  ${line}`)
						return error.code === "missing_hints" ? 2 : 1
					}
					console.error(`effect-orm: ${error instanceof Error ? error.message : String(error)}`)
					return 1
				}),
			),
		),
	)

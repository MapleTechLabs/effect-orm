#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path, Schema } from "effect"
import { check, runCommand } from "./release-support"

const PackageVersion = Schema.fromJsonString(Schema.Struct({ version: Schema.String }))
const PackResult = Schema.fromJsonString(
	Schema.Array(
		Schema.Struct({
			filename: Schema.String,
			files: Schema.Array(Schema.Struct({ path: Schema.String })),
		}),
	),
)

const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = yield* path.fromFileUrl(new URL("..", import.meta.url))
	// Outside the workspace, automatically removed on success, failure or Ctrl+C.
	const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "effect-orm-consumer-" })
	const version = Effect.fn(function* (name: "effect" | "typescript" | "@types/node") {
		const file = yield* path.fromFileUrl(new URL(import.meta.resolve(`${name}/package.json`)))
		const text = yield* fs.readFileString(file)
		return (yield* Schema.decodeEffect(PackageVersion)(text)).version
	})
	const output = yield* runCommand(
		"npm",
		["pack", "--ignore-scripts", "--json", "--pack-destination", temporary],
		root,
		true,
	)
	const packed = (yield* Schema.decodeEffect(PackResult)(output))[0]
	if (!packed) return yield* check(false, "tarball", "npm pack produced no artifact")
	yield* check(
		packed.files.some((file) => file.path === "dist/clickhouse.mjs") && packed.files.some((file) => file.path === "dist/postgres.mjs"),
		"tarball",
		"Missing built entry point",
	)
	yield* check(
		packed.files.every((file) => !/^(src|tests|node_modules)\//.test(file.path)),
		"tarball",
		"Tarball contains development files",
	)
	yield* fs.writeFileString(
		path.join(temporary, "package.json"),
		yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
			private: true,
			type: "module",
			dependencies: {
				"@maple-dev/effect-orm": `file:./${packed.filename}`,
				effect: yield* version("effect"),
			},
			devDependencies: {
				typescript: yield* version("typescript"),
				// Consumers still on TypeScript 5 see the built types too; see the consumer's Runnable check.
				"typescript-5": "npm:typescript@~5.9.3",
				"@types/node": yield* version("@types/node"),
			},
		}),
	)
	// npm is deliberately the consumer here; use the real tarball and disable
	// lifecycle scripts so workspace dependencies cannot conceal packaging errors.
	yield* runCommand("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], temporary)
	yield* fs.copyFile(path.join(root, "tests/package-consumer.mts"), path.join(temporary, "consumer.mts"))
	yield* fs.writeFileString(
		path.join(temporary, "tsconfig.json"),
		yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
			compilerOptions: {
				target: "ES2022",
				module: "NodeNext",
				moduleResolution: "NodeNext",
				strict: true,
				noEmit: true,
				skipLibCheck: false,
				types: ["node"],
				lib: ["ES2022", "ESNext.Disposable", "DOM"],
			},
			include: ["consumer.mts"],
		}),
	)
	yield* runCommand(path.join(temporary, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], temporary)
	// The TypeScript 5 checks, alone in their own program (see the file's header), on both compilers.
	yield* fs.copyFile(path.join(root, "tests/package-consumer-ts5.mts"), path.join(temporary, "consumer-ts5.mts"))
	const ts5Config = path.join(temporary, "tsconfig.ts5.json")
	yield* fs.writeFileString(
		ts5Config,
		yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ extends: "./tsconfig.json", include: ["consumer-ts5.mts"] }),
	)
	yield* runCommand(path.join(temporary, "node_modules/.bin/tsc"), ["-p", ts5Config], temporary)
	yield* runCommand("node", [path.join(temporary, "node_modules/typescript-5/bin/tsc"), "-p", ts5Config], temporary)
	yield* runCommand("node", ["consumer-ts5.mts"], temporary)
	// Exported queries and helpers must survive declaration emit, which is what a
	// package that shares its query definitions runs.
	yield* fs.copyFile(
		path.join(root, "tests/package-consumer-declarations.mts"),
		path.join(temporary, "consumer-declarations.mts"),
	)
	const declarationConfig = path.join(temporary, "tsconfig.declarations.json")
	yield* fs.writeFileString(
		declarationConfig,
		yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
			extends: "./tsconfig.json",
			compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true, outDir: "declarations" },
			include: ["consumer-declarations.mts"],
		}),
	)
	yield* runCommand(path.join(temporary, "node_modules/.bin/tsc"), ["-p", declarationConfig], temporary)
	yield* runCommand("node", [path.join(temporary, "node_modules/typescript-5/bin/tsc"), "-p", declarationConfig], temporary)
	// The script runs on Bun; the published library must also work in Node.
	yield* runCommand("node", ["consumer.mts"], temporary)
	// And from CommonJS, through `require(esm)`: every entry, from the real tarball.
	yield* fs.copyFile(path.join(root, "tests/package-consumer.cjs"), path.join(temporary, "consumer.cjs"))
	yield* runCommand("node", ["consumer.cjs"], temporary)
	yield* runCommand(
		path.join(temporary, "node_modules/.bin/ch-bench"),
		["schema", "--json"],
		temporary,
		true,
	)
	yield* runCommand(path.join(temporary, "node_modules/.bin/effect-orm"), ["--help"], temporary, true)
})

// This is the CLI entry point; provide platform services once at the boundary.
// oxlint-disable-next-line effecttsgo/strict-effect-provide
program.pipe(Effect.scoped, Effect.provide(BunServices.layer), BunRuntime.runMain)

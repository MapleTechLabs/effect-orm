import { defineConfig } from "tsdown"

export default defineConfig({
	entry: {
		clickhouse: "./src/clickhouse.ts",
		expr: "./src/expr.ts",
		sql: "./src/sql/index.ts",
		postgres: "./src/postgres.ts",
		schema: "./src/schema.ts",
		tinybird: "./src/tinybird.ts",
		migrate: "./src/migrate.ts",
		database: "./src/database.ts",
		kit: "./src/kit.ts",
		"kit/bin": "./src/kit/bin.ts",
		"benchmark/index": "./src/benchmark/index.ts",
		"benchmark/http": "./src/benchmark/http.ts",
		"benchmark/cli": "./src/benchmark/cli.ts",
		"benchmark/bin": "./src/benchmark/bin.ts",
	},
	format: "esm",
	dts: true,
	outDir: "dist",
	deps: {
		neverBundle: ["effect"],
	},
})

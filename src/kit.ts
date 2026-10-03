// @maple-dev/effect-orm/kit
//
// The authoring side, for Node or Bun: read the schema modules and the
// migrations folder, write the next migration, check the folder. The
// `effect-orm` bin runs these. See docs/migrations.md.

export { analyze, type GraphAnalysis, type GraphProblem } from "./kit/graph"
export {
	KitError,
	check,
	defineConfig,
	generate,
	loadSchema,
	readMigrations,
	type GenerateOptions,
	type GenerateResult,
	type KitConfig,
} from "./kit/generate"
export { runCli } from "./kit/cli"

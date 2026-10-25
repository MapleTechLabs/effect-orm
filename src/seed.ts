// @maple-dev/effect-orm/seed
//
// Test and demo rows from a table's column Schemas, through Effect's
// `Schema` → `Arbitrary`: deterministic with a seed, per-column overrides, the
// tenant column filled from one tenant, and inserts in batches through
// `insertInto`. No dependency beyond `effect`. See docs/seeding.md.

export {
	SeedError,
	arbitrary,
	insert,
	pick,
	rows,
	type ArbitraryOptions,
	type ColumnOverride,
	type InsertOptions,
	type RowsOptions,
	type SeedRow,
	type SeedRowOf,
} from "./seed/seed"

// The docs map. Read by scripts/sync-docs.mjs (which writes the pages) and
// astro.config.ts (which builds the sidebar and the header tabs).
//
// Each dialect is a top-level section with its own URLs: a guide in a dialect
// group is written once in docs/ and rendered under every dialect it lists, at
// `/<dialect>/<group>/<slug>/`, keeping only that dialect's blocks (see
// "Dialect blocks" in ../AGENT.md). Shared groups render once, at `/<group>/<slug>/`.
//
// `label` shortens the sidebar title; `description` feeds meta tags, search and
// llms.txt; `dialects` limits a page to some dialects (default: all of them).

export const dialects = [
	{ id: "clickhouse", label: "ClickHouse", alias: "CH", entry: "@maple-dev/effect-orm/clickhouse" },
	{ id: "postgres", label: "Postgres", alias: "PG", entry: "@maple-dev/effect-orm/postgres" },
	{ id: "sqlite", label: "SQLite", alias: "SQLite", entry: "@maple-dev/effect-orm/sqlite" },
	{ id: "mysql", label: "MySQL", alias: "MySQL", entry: "@maple-dev/effect-orm/mysql" },
]

export const dialectIds = dialects.map((d) => d.id)

export const groups = [
	{
		dir: "start",
		label: "Getting started",
		pages: [
			{ file: "README.md", slug: "overview", title: "Overview", description: "What effect-orm is, what it does and does not do, and where to start." },
			{ file: "getting-started.md", description: "Install effect-orm, define a table, then build, compile and decode a query." },
			{ file: "coming-from-drizzle-prisma.md", label: "From Drizzle or Prisma", description: "Drizzle and Prisma operations mapped to effect-orm, and what differs by design." },
			{ file: "recipes.md", description: "Complete examples for everyday queries." },
		],
	},
	{
		// The pages that exist for one dialect only.
		dir: "specifics",
		label: (dialect) => `${dialect.label} specifics`,
		pages: [
			{ file: "postgres.md", slug: "overview", title: "Postgres", dialects: ["postgres"], description: "The Postgres dialect, its column types and functions." },
			{ file: "sqlite.md", slug: "overview", title: "SQLite and D1", dialects: ["sqlite"], description: "The SQLite entry: codecs, functions, table DDL, drivers and Cloudflare D1." },
			{ file: "mysql.md", slug: "overview", title: "MySQL", dialects: ["mysql"], description: "The MySQL entry: codecs, functions, @effect/sql-mysql2 wiring, collations and DDL." },
			{ file: "tinybird.md", label: "Tinybird", dialects: ["clickhouse"], description: "Tinybird datasources and views as query tables." },
		],
	},
	{
		dir: "queries",
		label: "Queries",
		pages: [
			{ file: "tables-and-types.md", description: "table(), column options, external tables, and the column-type constructors." },
			{ file: "queries.md", description: "select, where, groupBy, orderBy, limit, format, immutability and pipe." },
			{ file: "expressions.md", description: "Comparisons, arithmetic, optional predicates and aggregates." },
			{ file: "joins-and-subqueries.md", description: "The join family, fromQuery and correlated subqueries." },
			{ file: "unions-and-ctes.md", description: "unionAll, fromUnion and withCTE." },
			{ file: "inserts.md", description: "insertInto, the insert row type, DEFAULT and binding." },
			{ file: "updates-and-deletes.md", label: "Updates and deletes", description: "update, deleteFrom, allRows and ClickHouse mutations." },
			{ file: "params-and-compilation.md", description: "param.*, how values reach the SQL, and CompiledQuery." },
			{ file: "decoding-results.md", description: "rowSchema, decodeRows, decodeFirstRow and decode errors." },
			{ file: "running-queries.md", label: "Running a query", description: "Executing the SQL with a real client, wire settings and SETTINGS." },
			{ file: "extending.md", description: "defineFn, raw escape hatches and handwritten SQL." },
		],
	},
	{
		dir: "database",
		label: "Database",
		pages: [
			{ file: "database.md", label: "Statements and transactions", description: "Database over your SqlClient: run, execute, transaction, retry and repositories." },
			{ file: "relations.md", description: "defineRelations and findMany with nested with, tenant scope per level." },
			{ file: "migrations.md", description: "DDL from table definitions, materializedView, effect-orm generate and applying migrations." },
			{ file: "tenant-scoping.md", description: "tenantScope, what marks a query scoped, and crossTenant()." },
			{ file: "seeding.md", description: "Deterministic test and demo rows from the column Schemas." },
			{ file: "testing.md", description: "layerTest for unit tests without a server, and the release checks." },
		],
	},
	{
		dir: "benchmarks",
		label: "Benchmarks",
		shared: true,
		pages: [
			{ file: "benchmarking.md", label: "Benchmarking", description: "Define suites, measure baseline and candidate runs, verify results and compare budgets." },
			{ file: "benchmark-agent.md", description: "A repeatable optimization workflow and evidence checklist for agents." },
		],
	},
	{
		dir: "reference",
		label: "Reference",
		shared: true,
		pages: [
			{ file: "reference.md", description: "The full export catalog by module, plus error types." },
			{ file: "troubleshooting.md", description: "Common failures and sharp edges." },
		],
	},
]

/** The label of `group` inside `dialect`'s section. */
export const groupLabel = (group, dialect) => (typeof group.label === "function" ? group.label(dialect) : group.label)

/** The pages of a dialect group that render under `dialect`. */
export const pagesFor = (group, dialect) => group.pages.filter((p) => !p.dialects || p.dialects.includes(dialect.id))

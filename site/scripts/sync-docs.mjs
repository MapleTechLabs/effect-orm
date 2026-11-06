#!/usr/bin/env node
// `docs/*.md` at the repo root stays the source of truth: it ships in the npm
// package, renders on GitHub, and is checked by `scripts/check-doc-*.mjs`.
// This script copies it into the Nimbus content collection, adding the
// frontmatter Nimbus needs and rewriting links for the site's URLs. The output
// is generated (and gitignored), so edit `docs/`, never `src/content/docs/`.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const site = join(dirname(fileURLToPath(import.meta.url)), "..")
const repo = join(site, "..")
const source = join(repo, "docs")
const out = join(site, "src/content/docs")
const GITHUB = "https://github.com/MapleTechLabs/effect-orm/blob/main"

/**
 * Sidebar layout: group folder → pages in reading order. A page's site URL is
 * `/<group>/<slug>/`. `label` shortens the sidebar title; `description` feeds
 * meta tags, search, and llms.txt.
 */
const groups = [
	{
		dir: "start",
		label: "Getting started",
		icon: "ph:rocket-launch",
		pages: [
			{ file: "README.md", slug: "overview", title: "Overview", description: "What effect-orm is, what it does and does not do, and where to start." },
			{ file: "getting-started.md", description: "Install effect-orm, define a table, then build, compile and decode a query." },
			{ file: "coming-from-drizzle-prisma.md", label: "From Drizzle or Prisma", description: "Drizzle and Prisma operations mapped to effect-orm, and what differs by design." },
			{ file: "recipes.md", description: "Complete examples for everyday queries." },
		],
	},
	{
		dir: "queries",
		label: "Queries",
		icon: "ph:magnifying-glass",
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
		icon: "ph:database",
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
		dir: "dialects",
		label: "Dialects",
		icon: "ph:stack",
		pages: [
			{ file: "postgres.md", description: "The Postgres dialect, its column types and functions." },
			{ file: "sqlite.md", label: "SQLite and D1", description: "The SQLite entry: codecs, functions, table DDL, drivers and Cloudflare D1." },
			{ file: "mysql.md", description: "The MySQL entry: codecs, functions, @effect/sql-mysql2 wiring, collations and DDL." },
			{ file: "tinybird.md", label: "Tinybird", description: "Tinybird datasources and views as query tables." },
		],
	},
	{
		dir: "benchmarks",
		label: "Benchmarks",
		icon: "ph:gauge",
		pages: [
			{ file: "benchmarking.md", label: "Benchmarking", description: "Define suites, measure baseline and candidate runs, verify results and compare budgets." },
			{ file: "benchmark-agent.md", description: "A repeatable optimization workflow and evidence checklist for agents." },
		],
	},
	{
		dir: "reference",
		label: "Reference",
		icon: "ph:book-open",
		pages: [
			{ file: "reference.md", description: "The full export catalog by module, plus error types." },
			{ file: "troubleshooting.md", description: "Common failures and sharp edges." },
		],
	},
]

// file name → site path, for link rewriting.
const routes = new Map()
for (const group of groups) {
	for (const page of group.pages) {
		page.slug ??= page.file.replace(/\.md$/, "")
		routes.set(page.file, `/${group.dir}/${page.slug}/`)
	}
}
const listed = new Set(routes.keys())
const missing = readdirSync(source).filter((f) => f.endsWith(".md") && !listed.has(f))
if (missing.length > 0) {
	console.error(`sync-docs: add these docs to the sidebar in site/scripts/sync-docs.mjs:\n  ${missing.join("\n  ")}`)
	process.exit(1)
}

const yaml = (value) => JSON.stringify(value)

/** Rewrites one Markdown link target for the site. */
const rewriteHref = (href, file) => {
	if (/^[a-z]+:/i.test(href) || href.startsWith("#")) return href
	const [path, hash = ""] = href.split(/(?=#)/)
	const local = path.replace(/^\.\//, "")
	if (routes.has(local)) return routes.get(local) + hash
	// Anything else relative points into the repo: send it to GitHub.
	const resolved = join("docs", path).replace(/\\/g, "/")
	if (resolved.startsWith("..")) throw new Error(`${file}: link escapes the repo: ${href}`)
	return `${GITHUB}/${resolved}${hash}`
}

/** Applies `fn` to Markdown outside fenced code blocks. */
const outsideFences = (markdown, fn) =>
	markdown
		.split(/(^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[ \t]*$)/m)
		.map((part, i) => (i % 2 === 1 ? part : fn(part)))
		.join("")

const ALERT_TYPES = { NOTE: "note", TIP: "tip", IMPORTANT: "note", WARNING: "caution", CAUTION: "danger" }

/** GitHub alerts (`> [!WARNING]`) → Nimbus admonitions styled like `<Aside>`. */
const convertAlerts = (markdown) =>
	markdown.replace(/^> \[!(\w+)\][ \t]*\n((?:>.*\n?)*)/gm, (_, kind, body) => {
		const type = ALERT_TYPES[kind.toUpperCase()] ?? "note"
		const text = body.replace(/^> ?/gm, "").trimEnd()
		return `:::${type}\n${text}\n:::\n`
	})

const transform = (markdown, file) =>
	outsideFences(markdown, (text) =>
		convertAlerts(
			text
				// Inline links and images: [text](target)
				.replace(/(\]\()([^)\s]+)(\))/g, (_, open, href, close) => open + rewriteHref(href, file) + close)
				// Reference definitions: [id]: target
				.replace(/^(\[[^\]]+\]:\s*)(\S+)/gm, (_, def, href) => def + rewriteHref(href, file)),
		),
	)

// Only the group folders are generated; `index.mdx` (the home page) is hand-written.
for (const group of groups) rmSync(join(out, group.dir), { recursive: true, force: true })

let count = 0
groups.forEach((group, groupIndex) => {
	const dir = join(out, group.dir)
	mkdirSync(dir, { recursive: true })
	group.pages.forEach((page, pageIndex) => {
		const raw = readFileSync(join(source, page.file), "utf8")
		const h1 = raw.match(/^# (.+)\n+/)
		const title = page.title ?? h1?.[1].trim() ?? page.slug
		const body = h1 ? raw.slice(h1.index + h1[0].length) : raw
		const sidebar = [`  order: ${pageIndex}`]
		if (page.label) sidebar.push(`  label: ${yaml(page.label)}`)
		if (pageIndex === 0) {
			// The first page of a folder labels the group and orders it.
			sidebar.push(`  group:`, `    label: ${yaml(group.label)}`, `    icon: ${group.icon}`)
		}
		const frontmatter = [
			"---",
			`title: ${yaml(title)}`,
			`description: ${yaml(page.description)}`,
			"sidebar:",
			...sidebar,
			"---",
			`{/* Generated from docs/${page.file} by site/scripts/sync-docs.mjs. Edit that file instead. */}`,
			"",
			"",
		].join("\n")
		// The group order comes from its lowest child's order, so offset by group.
		const ordered = frontmatter.replace(`order: ${pageIndex}`, `order: ${groupIndex * 100 + pageIndex + 1}`)
		writeFileSync(join(dir, `${page.slug}.mdx`), ordered + transform(body, page.file))
		count++
	})
})

console.log(`sync-docs: ${count} pages from docs/`)

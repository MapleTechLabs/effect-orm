#!/usr/bin/env node
// Copies ../docs/*.md into src/content/docs/ for the site. A guide in a dialect
// group is written once per dialect it lists, at `<dialect>/<group>/<slug>.mdx`,
// keeping only that dialect's blocks; a shared group's guide is written once, at
// `<group>/<slug>.mdx`. Adds frontmatter, rewrites `./x.md` links to site URLs
// and other repo links to GitHub, and turns GitHub alerts into callouts.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { dialectIds, dialects, groups, pagesFor } from "./sidebar.mjs"

const site = join(dirname(fileURLToPath(import.meta.url)), "..")
const repo = join(site, "..")
const source = join(repo, "docs")
const out = join(site, "src/content/docs")
const GITHUB = "https://github.com/MapleTechLabs/effect-orm/blob/main"

// docs file → its URL per dialect (`shared` for a shared group's page).
const routes = new Map()
for (const group of groups) {
	for (const page of group.pages) {
		page.slug ??= page.file.replace(/\.md$/, "")
		for (const id of page.dialects ?? []) {
			if (!dialectIds.includes(id)) throw new Error(`sidebar.mjs: ${page.file} lists unknown dialect "${id}"`)
		}
		const urls = new Map()
		if (group.shared) urls.set("shared", `/${group.dir}/${page.slug}/`)
		else for (const dialect of dialects) {
			if (pagesFor(group, dialect).includes(page)) urls.set(dialect.id, `/${dialect.id}/${group.dir}/${page.slug}/`)
		}
		routes.set(page.file, urls)
	}
}
const listed = new Set(routes.keys())
const missing = readdirSync(source).filter((f) => f.endsWith(".md") && !listed.has(f))
if (missing.length > 0) {
	console.error(`sync-docs: add these docs to the sidebar in site/scripts/sidebar.mjs:\n  ${missing.join("\n  ")}`)
	process.exit(1)
}

const yaml = (value) => JSON.stringify(value)

/** The URL of a docs file from a page in `dialect`: its own dialect's copy when it has one. */
const urlOf = (file, dialect) => {
	const urls = routes.get(file)
	return urls.get("shared") ?? urls.get(dialect?.id) ?? urls.values().next().value
}

/** Rewrites one Markdown link target for the site. */
const rewriteHref = (href, file, dialect) => {
	if (/^[a-z]+:/i.test(href) || href.startsWith("#")) return href
	const [path, hash = ""] = href.split(/(?=#)/)
	const local = path.replace(/^\.\//, "")
	if (routes.has(local)) return urlOf(local, dialect) + hash
	const resolved = join("docs", path).replace(/\\/g, "/")
	if (resolved.startsWith("..")) throw new Error(`${file}: link escapes the repo: ${href}`)
	return `${GITHUB}/${resolved}${hash}`
}

const FENCE = /(^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[ \t]*$)/m

/** Applies `fn` to Markdown outside fenced code blocks. */
const outsideFences = (markdown, fn) =>
	markdown
		.split(FENCE)
		.map((part, i) => (i % 2 === 1 ? part : fn(part)))
		.join("")

/** The dialect ids in a `dialect="a,b"` list, checked. */
const parseDialects = (list, file) => {
	const ids = list.split(",").map((s) => s.trim())
	for (const id of ids) if (!dialectIds.includes(id)) throw new Error(`${file}: unknown dialect "${id}"`)
	return ids
}

/**
 * Keeps the blocks of one dialect, or every block on a shared page
 * (`dialect` undefined). Prose blocks are `<!-- dialect: a,b -->` …
 * `<!-- /dialect -->` on lines of their own; a code block is one whose info
 * string has `dialect="a,b"`. The markers themselves are removed.
 */
const selectDialect = (markdown, file, dialect) => {
	const prose = markdown.replace(
		/^<!-- dialect: ([a-z, ]+) -->[ \t]*\n([\s\S]*?)^<!-- \/dialect -->[ \t]*\n?/gm,
		(_, list, body) => (!dialect || parseDialects(list, file).includes(dialect.id) ? body : ""),
	)
	if (/<!-- \/?dialect/.test(prose)) throw new Error(`${file}: unbalanced <!-- dialect --> marker`)
	return prose
		.split(FENCE)
		.map((part, i) => {
			if (i % 2 === 0) return part
			const info = part.match(/^[^\n]*/)[0]
			const marked = info.match(/ dialect="([^"]+)"/)
			if (!marked) return part
			if (dialect && !parseDialects(marked[1], file).includes(dialect.id)) return null
			return part.replace(info, info.replace(marked[0], ""))
		})
		.filter((part) => part !== null)
		.join("")
		.replace(/\n{3,}/g, "\n\n")
}

/**
 * A note atop a dialect page whose examples are all in other dialects, until
 * that dialect's versions are written.
 */
const fallbackNote = (markdown, file, dialect) => {
	if (!dialect) return ""
	// Most snippets skip the import, so `CH.from(…)` counts as using ClickHouse too.
	const code = (markdown.match(new RegExp(FENCE.source, "gm")) ?? []).join("\n")
	const used = dialects.filter(
		(d) => code.includes(`from "${d.entry}"`) || new RegExp(`(?<![\\w.])${d.alias}\\.[a-z]`).test(code),
	)
	if (used.length === 0 || used.includes(dialect)) return ""
	const names = used.map((d) => d.label).join(" and ")
	const specifics = groups
		.find((g) => g.dir === "specifics")
		.pages.find((p) => p.dialects?.includes(dialect.id) && p.slug === "overview")
	const more = specifics ? ` ([${dialect.label} specifics](${urlOf(specifics.file, dialect)}))` : ""
	return [
		":::note",
		`The examples on this page use ${names} until the ${dialect.label} versions are written. The query builder is the same in every dialect: import \`${dialect.entry}\` as \`${dialect.alias}\` instead, and use ${dialect.label}'s column types and functions${more}.`,
		":::",
		"",
		"",
	].join("\n")
}

const ALERT_TYPES = { NOTE: "note", TIP: "tip", IMPORTANT: "note", WARNING: "caution", CAUTION: "danger" }

/** GitHub alerts (`> [!WARNING]`) → Nimbus admonitions styled like `<Aside>`. */
const convertAlerts = (markdown) =>
	markdown.replace(/^> \[!(\w+)\][ \t]*\n((?:>.*\n?)*)/gm, (_, kind, body) => {
		const type = ALERT_TYPES[kind.toUpperCase()] ?? "note"
		const text = body.replace(/^> ?/gm, "").trimEnd()
		return `:::${type}\n${text}\n:::\n`
	})

const transform = (markdown, file, dialect) => {
	const selected = selectDialect(markdown, file, dialect)
	return (
		fallbackNote(selected, file, dialect) +
		outsideFences(selected, (text) =>
			convertAlerts(
				text
					.replace(/(\]\()([^)\s]+)(\))/g, (_, open, href, close) => open + rewriteHref(href, file, dialect) + close)
					.replace(/^(\[[^\]]+\]:\s*)(\S+)/gm, (_, def, href) => def + rewriteHref(href, file, dialect)),
			),
		)
	)
}

// Every folder is generated; `index.mdx` (the home page) is hand-written.
for (const entry of readdirSync(out, { withFileTypes: true })) {
	if (entry.isDirectory()) rmSync(join(out, entry.name), { recursive: true, force: true })
}

let count = 0
const writePages = (dir, pages, dialect) => {
	mkdirSync(dir, { recursive: true })
	pages.forEach((page, pageIndex) => {
		const raw = readFileSync(join(source, page.file), "utf8")
		const h1 = raw.match(/^# (.+)\n+/)
		const title = page.title ?? h1?.[1].trim() ?? page.slug
		const body = h1 ? raw.slice(h1.index + h1[0].length) : raw
		const sidebar = [`  order: ${pageIndex + 1}`]
		if (page.label) sidebar.push(`  label: ${yaml(page.label)}`)
		// Until a guide has blocks of its own for this dialect, its copy here
		// matches the ClickHouse one; leave it out of site search so a query
		// doesn't list the same page four times. It stays reachable by tab.
		const duplicate =
			dialect !== undefined &&
			dialect.id !== "clickhouse" &&
			routes.get(page.file).has("clickhouse") &&
			selectDialect(body, page.file, dialect) === selectDialect(body, page.file, dialects[0])
		const frontmatter = [
			"---",
			`title: ${yaml(title)}`,
			`description: ${yaml(page.description)}`,
			"sidebar:",
			...sidebar,
			...(duplicate ? ["searchable: false"] : []),
			"---",
			`{/* Generated from docs/${page.file} by site/scripts/sync-docs.mjs. Edit that file instead. */}`,
			"",
			"",
		].join("\n")
		writeFileSync(join(dir, `${page.slug}.mdx`), frontmatter + transform(body, page.file, dialect))
		count++
	})
}

for (const group of groups) {
	if (group.shared) {
		writePages(join(out, group.dir), group.pages, undefined)
		continue
	}
	for (const dialect of dialects) {
		const pages = pagesFor(group, dialect)
		if (pages.length > 0) writePages(join(out, dialect.id, group.dir), pages, dialect)
	}
}

console.log(`sync-docs: ${count} pages from docs/`)

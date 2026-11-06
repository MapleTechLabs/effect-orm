#!/usr/bin/env node
// `docs/*.md` at the repo root stays the source of truth: it ships in the npm
// package, renders on GitHub, and is checked by `scripts/check-doc-*.mjs`.
// This script copies it into the Nimbus content collection, adding the
// frontmatter Nimbus needs and rewriting links for the site's URLs. The output
// is generated (and gitignored), so edit `docs/`, never `src/content/docs/`.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { groups } from "./sidebar.mjs"

const site = join(dirname(fileURLToPath(import.meta.url)), "..")
const repo = join(site, "..")
const source = join(repo, "docs")
const out = join(site, "src/content/docs")
const GITHUB = "https://github.com/MapleTechLabs/effect-orm/blob/main"

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
	console.error(`sync-docs: add these docs to the sidebar in site/scripts/sidebar.mjs:\n  ${missing.join("\n  ")}`)
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
for (const group of groups) {
	const dir = join(out, group.dir)
	mkdirSync(dir, { recursive: true })
	group.pages.forEach((page, pageIndex) => {
		const raw = readFileSync(join(source, page.file), "utf8")
		const h1 = raw.match(/^# (.+)\n+/)
		const title = page.title ?? h1?.[1].trim() ?? page.slug
		const body = h1 ? raw.slice(h1.index + h1[0].length) : raw
		const sidebar = [`  order: ${pageIndex + 1}`]
		if (page.label) sidebar.push(`  label: ${yaml(page.label)}`)
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
		writeFileSync(join(dir, `${page.slug}.mdx`), frontmatter + transform(body, page.file))
		count++
	})
}

console.log(`sync-docs: ${count} pages from docs/`)

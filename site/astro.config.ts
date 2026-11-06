import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import nimbus, {
  defineConfig as defineNimbusConfig,
} from "@cloudflare/nimbus-docs";
import { tableScroll } from "@cloudflare/nimbus-docs/markdown";
import { dialects, groupLabel, groups, pagesFor } from "./scripts/sidebar.mjs";

const nimbusConfig = defineNimbusConfig({
  // Canonical origin (no trailing slash): the package.json `homepage`. Drives
  // canonical URLs, OG images, robots.txt, the sitemap and /llms.txt.
  site: "https://effect-orm.maple.dev",
  title: "effect-orm",
  description:
    "Type-safe ClickHouse, Postgres, SQLite and MySQL queries, result decoding, and benchmarks for Effect and TypeScript.",
  locale: "en",
  github: "https://github.com/MapleTechLabs/effect-orm",
  socialImageAlt: "effect-orm documentation preview",
  // One section per dialect, then the shared groups; each is a header tab, and
  // the sidebar shows only the current one. The folders are the ones
  // scripts/sync-docs.mjs writes.
  sidebar: {
    scope: "section",
    items: [
      ...dialects.map((dialect) => ({
        label: dialect.label,
        segment: `/${dialect.id}`,
        items: groups
          .filter((group) => !group.shared && pagesFor(group, dialect).length > 0)
          .map((group) => ({
            label: groupLabel(group, dialect),
            autogenerate: { directory: `${dialect.id}/${group.dir}` },
          })),
      })),
      ...groups
        .filter((group) => group.shared)
        .map((group) => ({ label: group.label as string, autogenerate: { directory: group.dir } })),
    ],
  },
});

export default defineConfig({
  // nimbus:adapter
  output: "static",
  // Tailwind v4 via its Vite plugin (the integration Astro recommends for
  // Tailwind v4 — replaces the PostCSS plugin, which doesn't build under
  // Astro 7's Vite 8 bundler).
  vite: {
    plugins: [tailwindcss()],
  },
  // Hover-prefetch link targets so full-page navigations feel instant without
  // a client-side router.
  prefetch: {
    prefetchAll: true,
    defaultStrategy: "hover",
  },
  integrations: [
    nimbus(nimbusConfig, {
      // Authoring rules are opt-in by design — your repo, your taste. The
      // two below are the load-bearing pair: frontmatter has to validate
      // against the content schema for the page to render properly, and
      // broken internal links are 404s for your readers. Add the others
      // (heading hierarchy, code-block language, style, etc.) when you're
      // ready to enforce them — see `nimbus-docs lint --help`.
      rules: {
        "nimbus/frontmatter-shape": "error",
        "nimbus/internal-link": "error",
      },
      markdown: {
        // Wrap wide tables so they scroll instead of overflowing the page
        // (styled by `.nb-table-scroll` in src/styles/prose.css).
        hastPlugins: [tableScroll()],
        // `## Install {#install}` gives a heading a fixed id. A heading that
        // ends in other `{…}` text, such as `{account_id}` in a .md file, is
        // read as attributes too; remove this to keep it as text.
        features: { headingAttributes: true },
      },
    }),
  ],
});

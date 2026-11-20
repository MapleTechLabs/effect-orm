---
"@maple-dev/effect-orm": major
---

1.0.0. The package follows semantic versioning from here: a breaking change to a documented export is a major release. Every export of every entry is named in the API reference (`docs/reference.md`), and `bun run test` now fails when one is not; before, only the four dialect entries were checked. The Alpha notice is gone from the README and the docs site. `package.json` declares `engines.node >= 20.19.0`, the oldest Node the build was run on.

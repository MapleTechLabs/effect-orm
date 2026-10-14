---
"@maple-dev/effect-orm": patch
---

Every entry point can be loaded with `require()`. The export map offered only an `import` condition, so CommonJS code (and CommonJS builds of TypeScript projects) failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although the modules themselves load fine through Node's `require(esm)` (Node 20.19+, 22.12+). Each entry now also has a `default` condition pointing at the same `.mjs`, so a CommonJS caller loads the very module an ES module caller does, and shares its Effect. The package-consumer check `require()`s every entry from the packed tarball.

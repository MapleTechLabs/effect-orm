---
"@maple-dev/effect-orm": patch
---

`effect-orm --version` and `ch-bench --version` print the package version. `effect-orm` names a command it does not have (`unknown command "frobnicate"`) before it looks for a config file; it used to report that `effect-orm.config.ts` could not be imported.

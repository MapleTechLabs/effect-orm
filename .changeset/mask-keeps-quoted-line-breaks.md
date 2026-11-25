---
"@maple-dev/effect-orm": patch
---

`maskLiteralsAndComments` keeps a line break that is inside a quoted string or identifier, as it already did inside a comment. It replaced one with a space, so line numbers counted in the masked text were off after a multi-line literal.

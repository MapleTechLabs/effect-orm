---
"@maple-dev/effect-orm": patch
---

An arithmetic expression passed as an argument keeps its parentheses: `$.a.sub($.b.add(1))` compiles to `a - (b + 1)`, not `a - b + 1`. Chains still follow SQL precedence as documented (`$.a.sub(1).div(2)` is `a - 1 / 2`); passing the group as an argument is how to group.

# Extending the DSL

The wrapped function catalog is deliberately partial — it covers what gets used, not all of
ClickHouse. There are four escape hatches, in increasing order of how much they give up.

## `defineFn` — declare a missing function

One line for any standard `fn(args…)` function. You supply the argument tuple, the return type,
and the ClickHouse type it produces:

```ts
import type { DateTime } from "effect"

const toStartOfFiveMinute = CH.defineFn<[CH.Expr<DateTime.Utc>], DateTime.Utc>(
	"toStartOfFiveMinute",
	CH.dateTime,
)

CH.from(Events)
	.select(($) => ({ bucket: toStartOfFiveMinute($.Timestamp) }))
	.where(($) => [$.OrgId.eq("org_123")])
// toStartOfFiveMinute(Timestamp) AS bucket
```

Arguments are compiled through the same escaping path as everything else, so raw values are
safe to pass. This is the right tool almost every time.

The result type is **required**, and that is the whole point: row schemas are derived from the
SELECT and derivation is all-or-nothing, so one function that never declared its result costs
every query using it the ability to decode anything. `defineUntypedFn` says a result genuinely
has no type — use it only for values that never become a row.

_(Backed by `docs/extending.md > defineFn declares a missing function`.)_

### Results that depend on the arguments

Plenty of ClickHouse functions hand back one of their inputs rather than a fixed type. Pass a
rule instead of a type:

| Rule            | Meaning                                       | Example                     |
| --------------- | --------------------------------------------- | --------------------------- |
| `sameAs(i)`     | decodes as argument `i` does                  | `min`, `argMax`, `over`     |
| `firstTyped()`  | decodes as the first argument that has a type | `coalesce`, `if`            |
| `elementOf(i)`  | one element of argument `i`'s array           | `arrayJoin`, `arrayElement` |
| `arrayOfArg(i)` | an array of argument `i`                      | `groupUniqArray`            |

```ts
const anyLast = CH.defineFn<[CH.Expr<string>], string>("anyLast", CH.sameAs(0))
```

Any function of your own works: the rule is `(...args) => Schema.Codec | undefined`.

A rule is an _assertion_, the same way `rawExpr`'s type is: nothing checks that `sameAs(0)` on a
function you declared as returning a `number` actually yields one. Declare the rule that matches
what ClickHouse does.

### `defineCondFn` — for predicates

Same, but returning a `Condition` so it can go straight into `where`:

```ts
const matchesRegex = CH.defineCondFn<[CH.Expr<string>, string]>("match")

CH.from(Events)
	.select(($) => ({ name: $.Name }))
	.where(($) => [$.OrgId.eq("org_123"), matchesRegex($.Name, "^checkout")])
// match(Name, '^checkout')
```

_(Backed by `docs/extending.md > defineCondFn declares a predicate`.)_

## `compileFnCall` — variadic or generic shapes

When the signature is too irregular for `defineFn`, write the wrapper yourself:

```ts title="typed-function.ts"
import * as CH from "@maple-dev/effect-orm/clickhouse"

const greatestOf = (first: CH.Expr<number>, ...rest: CH.Expr<number>[]) =>
	CH.compileTypedFnCall("greatest", CH.float64.schema, first, ...rest)

const Events = CH.table("events", {
	columns: { Name: CH.string, DurationMs: CH.uint64 },
	engine: CH.engine.mergeTree(),
	orderBy: ["Name"],
})
export const compiled = CH.compileUnsafe(
	CH.from(Events).select(($) => ({ name: $.Name, durationMs: greatestOf($.DurationMs, CH.lit(1)) })),
	{},
)
console.log(compiled.rowSchemaSource) // "derived"
```

This wrapper accepts non-nullable numeric expressions and provides their result codec.
For other input types, choose a codec that matches the function's actual result.
Arguments still route through the standard fragment conversion, so escaping is preserved.
`compileFnCall` has no result codec: selecting its result disables derived decoding for
**the whole row**, even when its TypeScript return type is `Expr<number>`.
`compileFnCallCond` returns a predicate for use in `where`.

## `makeExpr` / `makeCond` — custom SQL syntax

For functions whose call syntax is not `fn(a, b)` at all — parametric aggregates, operators,
anything bespoke:

```ts
import { makeExpr } from "@maple-dev/effect-orm/clickhouse"
import { raw, compile } from "@maple-dev/effect-orm/sql"

const quantileExact =
	(q: number) =>
	<Q = never>(expr: CH.Expr<number, Q>) =>
		makeExpr(raw(`quantileExact(${q})(${compile(expr.toFragment())})`), CH.float64.schema, undefined, [expr])
```

This is how the bundled `quantile` is built. The last argument, `uses`, lists the expressions
the fragment interpolates (see [below](#params-and-checks-on-a-custom-function)). The value
type comes from the schema; `makeExpr<number>(…)` with an explicit type argument does not
type-check. Note the second argument: `makeExpr` requires a
schema — passing `undefined` is how a wrapper _forwards_ the untypedness of its own argument
(`schemaOf(arg)`), not something to write. For an expression that genuinely has no type, use
`makeUntypedExpr`, which says so and costs the query its row schema knowingly.

You are now assembling SQL text: interpolate only values you control, and route
user-supplied string values through `compile(str(value))` from the `/sql` subpath.
`str(value)` returns a fragment, not SQL text; interpolating that fragment directly
produces `[object Object]`. For example:

```ts title="escaped-sql.ts"
import { compile, str } from "@maple-dev/effect-orm/sql"

export const predicate = `Name = ${compile(str("O'Reilly"))}`
console.log(predicate) // Name = 'O\'Reilly'
```

Use this for string literals only. Keep SQL structure and identifiers under application
control, and validate numeric inputs such as the quantile level separately.

### Params and checks on a custom function

`Expr<T, P>` carries the `param.*` placeholders inside an expression, so `compile` can require
them. `defineFn`, `defineCondFn` and `compileTypedFnCall` pass their arguments' params on by
themselves. `makeExpr`, `makeUntypedExpr` and `makeCond` cannot see inside the SQL you build,
so they take the expressions you interpolate as `uses` (the last argument): the result carries
their params, and compiling fails with a `QueryBuilderDefect` if the SQL holds a param that no
`uses` entry carries. A param can therefore not reach a query without being in its type.

Generic functions take their params as one type parameter per argument (`Expr<number, Q>`
above); a parameter written as a plain `Expr<T>` accepts any expression but drops its params
from the type, so they are then checked only when compiling. SQL built with `makeExpr`, `defineFn` or `CH.sql` is also opaque to the GROUP
BY checks (see [Queries](./queries.md#groupby)): a mistake inside it reaches the database, but
it never makes a valid query fail.

## A column type of your own

`CH.custom(sql, schema)` is the extension point the built-in types are built from — `CH.uint64` is
`custom("UInt64", CHNumber)`. Declare one for a ClickHouse type this package does not model and
it works everywhere a built-in does: rows decode through it, literals encode through it, and
`param.of(type, name)` takes it as a param.

```ts
const Level = CH.custom("Enum8('warn' = 1, 'error' = 2)", Schema.Literals(["warn", "error"]))
const Decimal = CH.custom("Decimal(18, 4)", Schema.String)

const Logs = CH.table("logs", {
	columns: { OrgId: CH.string, Level, Amount: Decimal },
	engine: CH.engine.mergeTree(),
	orderBy: ["OrgId"],
})
```

This Decimal declaration expects decimal text from your client and preserves it as a string.
Converting a decimal to a JavaScript number can lose precision. Match the codec to the actual
response format; the SQL type label alone does not validate its scale or precision.

Pass a third argument when comparisons should accept more than the column decodes to — that is
how a `DateTime` column takes a `DateTime.Utc`, a `Date`, or the string form and writes the same
literal for all three.

_(Backed by `src/ch/literal.test.ts > param.of`.)_

## `CH.sql` — SQL templates inside a query

For SQL the builder has no syntax for — a cast, an operator, a Postgres function — write a
template. It is an expression (or, with `.cond`, a condition), so it goes anywhere the builder
takes one: a select, a `where`, a join's ON, an UPDATE's SET. `sql` is on both entries; this
example is Postgres.

```ts
PG.from(Keys)
	.select(($) => ({
		txid: PG.sql(PG.text)`pg_current_xact_id()::xid::text`,
		next: PG.sql(PG.int8)`${$.uses} + ${1}`,
	}))
	.where(($) => [PG.sql.cond`${$.meta} @> ${PG.param.string("filter")}::jsonb`])
// SELECT (pg_current_xact_id()::xid::text) AS "txid", ("keys"."uses" + 1) AS "next" …
// WHERE ("keys"."meta" @> $1::jsonb)
```

Each `${value}` renders as the rest of the builder renders it:

| Value | Renders as |
| --- | --- |
| a column, expression, or another template | its SQL |
| a `param.*` | a placeholder: bound on Postgres, a literal on ClickHouse |
| a builder query | `(subquery)`, compiled with the outer query, its tenant scope counted |
| a string | bound on Postgres (`$n`), the escaped literal on ClickHouse |
| a number, boolean, `Date`, `DateTime.Utc`, `null` | the dialect's escaped literal |
| `CH.sql.ident(name)` | the name quoted by the dialect; plain names only, dotted for `schema.table` |
| `CH.sql.raw(text)` | the text as-is — never from input |
| `CH.sql.join(values, separator?)` | each value rendered, joined by `", "` or `separator`; not parenthesized, so it fits `IN (${…})`; an empty list fails the compile |

A template is written in parentheses, so `CH.sql.cond\`a OR b\`` in a `where` list stays one
operand instead of swallowing the conditions it is AND-joined with. A negative number (or a
param ClickHouse inlines as one) is parenthesized too, so `10-${n}` cannot become the comment
`10--1`.

`sql.raw` and `sql.ident` values are recognised by identity, not by their fields, so an object
parsed from request JSON can never pass for one. An array or object has no literal the template
could write without its SQL type, so it fails the compile with a `QueryBuilderError`; pass it as
`param.of(type, name)` instead. A `unionAll` cannot be interpolated; select from it with
`fromUnion` and interpolate that. `CH.sql(type)`
declares the result type, which decodes the value when it is selected; a bare ``CH.sql`…` ``
has none and costs the query its row schema, as `untypedExpr` does. A template condition is not
evidence of tenant scope; being parenthesized, it cannot cancel the evidence of the conditions
beside it either.

_(Backed by `src/ch/sql-template.test.ts` and `src/database/database.test.ts`.)_

## Raw escape hatches

`rawExpr` and `rawCond` take a SQL string as-is; prefer `CH.sql`, which renders values and
params instead of taking text. `rawExpr` still requires the column type its
SQL produces, so the row it lands in can still be decoded:

```ts
CH.from(Events)
	.select(($) => ({ odd: CH.rawExpr("DurationMs % 2", CH.float64) }))
	.where(($) => [$.OrgId.eq("org_123"), CH.rawCond("Name GLOBAL IN (SELECT 1)")])
```

> Neither escapes nor validates the SQL, and the declared type is an assertion you are making
> about text the builder cannot read. **Never build one from user input.**

`untypedExpr(sql)` is the version for SQL whose result has no type to declare — a sort tuple
that is only ever an `argMin` tiebreaker, never a selected value. Selecting one costs the query
its row schema, so it is deliberately a separate name.

`dynamicColumn<T>(name, type?)` (on both dialect entries and `/expr`) is the same idea for a column name only
known at runtime; pass the type where you know it.

_(Backed by `docs/extending.md > rawExpr and rawCond are the last resort`.)_

## Handwritten queries: `rawCompiledQuery`

When a query cannot be expressed by the builder at all, wrap the SQL so downstream code still
sees a uniform `CompiledQuery`:

```ts
const compiled = CH.rawCompiledQuery<{ readonly name: string }>({
	sql: "SELECT Name AS name FROM events WHERE OrgId = 'org_123'",
	tenantScope: "single-tenant",
	reason: "user-authored-sql",
	justification: "The SQL came from a user; there is no AST to build.",
	rowSchema: Schema.Struct({ name: Schema.String }),
})
```

`tenantScope` is **required** — it cannot be inferred from a string, and whatever you assert is
taken at face value. That is the whole hazard: this is the one place tenant scope is asserted
rather than derived, so a query that forgot its tenant predicate would be positively _claimed_
as scoped and sail through an executor's gate.

`reason` and `justification` are therefore required too. What counts as a legitimate reason is a policy
of your codebase, not of this package, so `reason` is any string — pin it to a union of your own
to turn it into a review gate:

```ts
type RawSqlReason =
	| "user-authored-sql" // the SQL came from a user; there is no AST to build
	| "empty-result-stub" // a constant zero-row result reading no table
	| "test-fixture" // a test asserting executor behaviour on synthetic SQL

const rawQuery = <Output>(args: {
	sql: string
	tenantScope: CH.TenantScope
	reason: RawSqlReason
	justification: string
	// Not `Schema.Schema<Output>`, which leaves `DecodingServices` open and so is
	// a supertype of what a row codec may be. See docs/decoding-results.md.
	rowSchema?: CH.CompiledQueryRowSchema<Output>
}) => CH.rawCompiledQuery<Output>(args)
```

Adding a member to that union is then the review gate — a one-line diff in one file that a
reviewer cannot miss. Leave out a `"legacy"` or `"todo"` member: with one, the gate is
decorative.
If your query doesn't fit a member, the answer is almost always to express it in the builder.

Supply a `rowSchema` too: handwritten SQL is exactly where schema drift goes unnoticed, and
without one `decodeRows` validates nothing. See [Decoding results](./decoding-results.md).

_(Backed by `docs/extending.md > rawCompiledQuery wraps handwritten SQL`.)_

## The fragment AST

The `/sql` subpath exposes the layer everything above is built on:

```ts
import { raw, str, ident, int, join, as_, when, compile } from "@maple-dev/effect-orm/sql"
```

- `str(value)` — an escaped string literal. **Use this for anything user-supplied.**
- `ident(name)` — an identifier
- `raw(sql)` — verbatim SQL, escaping nothing
- `int(value)`, `join(sep, ...frags)`, `as_(frag, alias)`, `when(cond, frag)`
- `compile(fragment)` — render a fragment to a string
- `escapeClickHouseString(value)` — the escaping primitive itself

`SqlFragment` is an Effect `Data.TaggedEnum`, so it pattern-matches cleanly if you build tooling
over it.

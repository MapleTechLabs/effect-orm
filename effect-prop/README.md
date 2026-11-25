# effect-prop

Property-based testing for Effect. You state what must hold for every input; it
builds inputs, finds the ones that break the property, and hands back the
smallest of each kind with a token that reruns it.

It follows [ephyra](https://github.com/datadog-labs/ephyra) and
[Hypothesis](https://hypothesis.works): a generator records every random
decision it makes, and that record is the input. Replay, shrinking and
coverage-guided mutation are all "run the generator again on edited decisions",
so none of them needs code per type.

Status: experimental, in this repository only, not published. The API will
change. The examples import `effect-prop`; from this repository's tests, import
by path (`../../effect-prop/src/index`, `/node`, `/vitest`). Its modules are
named as Effect's are (`Gen.ts`, `Prop.ts`), since it is meant to leave this
repository as a package of its own.

```ts
import { Effect } from "effect"
import { expect } from "vitest"
import { Gen } from "effect-prop"
import { prop } from "effect-prop/vitest"

prop("a decoded row encodes back to itself", Gen.fromSchema(Row), (row) =>
	Effect.gen(function* () {
		const wire = yield* encode(row)
		expect(yield* decode(wire)).toEqual(row)
	}),
)
```

A failure fails the test with a report:

```
short lists: 1 distinct failure (37 runs, 0 discarded, seed 1, 4 ms)

  1. ReturnedFalse (found by search, shrunk in 6 steps)
    input:
      [0,0,0]
    the property returned false
    replay: PROP_REPLAY='p1.4.1.0.1.0.1.0.0'
```

## Generators

A `Gen<A>` is a synchronous function of a `Source`. Build them from the
combinators in `Gen`, or in sequence with `Gen.gen`:

```ts
const range = Gen.gen(function* () {
	const lo = yield* Gen.int(0, 10)
	const hi = yield* Gen.int(lo, 20) // may depend on earlier values
	return { lo, hi }
})
```

| | |
|---|---|
| Numbers | `int(min, max)`, `nat(max)`, `number({ min, max, nan, infinity })`, `boolean`, `weightedBoolean(p)` |
| Choice | `constant`, `element(...values)`, `elements(array)`, `oneOf(...gens)`, `weighted([weight, gen], ...)`, `option`, `nullable` |
| Collections | `array(gen, { minLength, maxLength })`, `uniqueArray`, `subsequence`, `shuffled`, `tuple`, `struct` |
| Text | `string({ char, minLength, maxLength })` (lengths in characters), `charOf(alphabet)`, `asciiChar`, `unicodeChar` |
| Structure | `map`, `flatMap`, `filter`, `gen`, `recursive(base, step)`, `lazy`, `sized`, `labeled` |
| Bridges | `fromSchema(schema)`, `fromArbitrary(arbitrary)`, `fromSeed(f)` |

Three rules make generators that find bugs and shrink well:

- **Simplest first.** A draw of 0 must mean the simplest value: the first
  alternative of `oneOf`, the base case of `recursive`. Shrinking lowers draws.
- **Valid by construction.** Build valid values from the grammar or the types.
  `filter` discards the whole input after three rejected tries.
- **Check the generator.** `Inspect.inspect(gen, { valid, label, expect })`
  samples it and reports discards, invalid values and labels it never produced.

The bridges draw one seed and hand it to the other library, so they shrink only
by trying other seeds. Prefer native generators where a small counterexample matters.

A generator that throws stops the check with the seed and a `PROP_REPLAY` value
that leads back to it: it is a bug in the test, not a finding.

## Properties

A property is a function of the input returning an Effect (or a plain
`boolean` or `void`). It fails by failing, dying or returning `false`.

- Each input runs in its own `Scope`: acquire a fixture in the property and it
  is released before the next input.
- Services come from the `layer` option of `prop`, built once per property.
- `timeout` fails an input that takes too long, with the signature `Timeout`.
  An Effect that yields is interrupted at the limit; code that never yields
  fails once it returns.
- Inside a property: `Prop.assume(condition)` skips the input,
  `Prop.label(name)` and `Prop.classify(condition, name)` count inputs in the
  report, `Prop.target(score)` scores it for `Search.target`.

Failures are grouped by **signature**: a typed error's `_tag`, otherwise the
error's name and where it was thrown. Set `failures: n` (or `PROP_FAILURES`) and
the run continues until it has `n` distinct signatures, shrinking and reporting
each. When one assertion covers several causes, name them with
`Prop.signature(name)`.

`Prop.check(gen, property, options)` is the Effect underneath `prop`. It
returns the `Report` whether or not the property held, and reads nothing but
its arguments: `prop` applies the `PROP_*` variables with `Prop.fromEnvironment`.

## Searches

`search` in the options chooses how inputs are picked:

| | |
|---|---|
| `Search.random` | Every input fresh. The default. |
| `Search.coverage` | Keeps inputs that did something new according to the provided `Feedback`, and mutates them. |
| `Search.target()` | Hill-climbs on `Prop.target(score)`, or on `Search.target(score)`'s own function of the input. |
| `Search.slow` | Hill-climbs on how long the property took. |

A search is a loop over a `Run`: `execute` inputs while it `wantsMore`. Write
your own the same way (see `src/Search.ts`).

`Feedback` says what "something new" means:

- `Coverage.layer({ include })` from `effect-prop/node`: V8 code coverage of the
  scripts `include` accepts. Node only.
- `Spans.layer`: parent and child span names the code under test opens. Works
  anywhere, and sees only what is traced.

```ts
import { Coverage } from "effect-prop/node"

prop("the parser never throws", input, (text) => void parse(text), {
	search: Search.coverage,
	layer: Coverage.layer({ include: (url) => url.includes("/src/parser") }),
})
```

What to know about V8 coverage:

- V8 has one set of counters per process. Run coverage-guided properties one at
  a time, and not under `vitest --coverage`: each would reset the other's counters.
- Collection starts with the first `Coverage.layer` and stays on until the
  process exits. Code V8 had already optimized by then reports calls and no
  branches: call `Coverage.start` earlier if the code under test runs hot first.
- The report gives line numbers for the project's files loaded before
  collection started, and names only for a file loaded later.
- A function with no branches stops being counted once V8 optimizes it, so a
  later property in the same process can list it as never reached.
- Reading coverage costs about a millisecond, so `Search.coverage` reads it once
  per batch of inputs and reruns a batch input by input only when it did
  something new.

## Replay and regressions

Settings come from the options, and `prop` lets the environment override them:

| Variable | Meaning |
|---|---|
| `PROP_REPLAY` | Run only the input a report's `replay` line names. Select the property with `-t`. |
| `PROP_SEED` | The seed. |
| `PROP_RUNS`, `PROP_SCALE` | The number of generated inputs, and a multiplier for it (also for `PROP_RUNS`). |
| `PROP_BUDGET_MS` | Stop searching after this long. Shrinking may take as long again. |
| `PROP_FAILURES` | How many distinct failures to look for. Default 1. |
| `PROP_VERBOSE` | `1` prints the report of a passing property too, with the functions no input reached. |

`prop` remembers each failure under `.prop/regressions` (commit it) and replays
them before any new input; `regressions: false` turns that off. Pinned examples
and replayed regressions run on top of `runs` and do not change what a seed
generates. A stored
failure is a record of decisions, so it belongs to the generator that made it:
after the generator changes it still builds a valid input, but perhaps a
different one. Pin an input that must keep its exact value with `examples`.

## Stateful properties

`Stateful.commands` generates a sequence of commands against a model, each one
valid for the state the earlier ones lead to; `Stateful.run` executes it on the
real system and checks every step. The shrinker removes commands and the
generator rebuilds the rest. See `test/Stateful.test.ts` for a queue with an
overflow bug, found and shrunk to five commands.

## How it compares

`bench/shrink.test.ts` runs six of the
[shrinking challenges](https://github.com/jlink/shrinking-challenge) on 30
seeds each. Both libraries found a failure on every seed; this is how often each
reached the known smallest input:

| Challenge | effect-prop | fast-check |
|---|---|---|
| reverse | 30/30 | 17/30 |
| distinct | 30/30 | 24/30 |
| nestedlists | 30/30 | 0/30 |
| lengthlist | 30/30 | 5/30 |
| bound5 | 30/30 | 3/30 |
| calculator | 30/30 | 6/30 |

```sh
PROP_BENCH=1 bunx vitest run effect-prop/bench --disable-console-intercept
```

## Not built yet

- A Schema-native generator: `fromSchema` goes through `Arbitrary` and shrinks by seed.
- Concurrent stateful testing, and ephyra's causality analysis of a failing trace.
- An HTML report and a CLI. Line-level coverage in the report: `Report.feedback`
  lists files and the functions no input reached.
- Publishing as its own package.

Testing a project with an agent: see [GUIDE.md](GUIDE.md).

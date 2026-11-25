# Testing a project with effect-prop

For a coding agent asked to test code with effect-prop. The goal is real bugs,
each with a small input that shows it, and tests that keep them fixed. Read
[README.md](README.md) for the API. This page is about how to work.

## 1. Decide what correct means before generating anything

Read the docs, the types and the existing tests. Expected behaviour must come
from the project: a sentence in its docs, a type, a test, or a universal rule
(no crash, no hang, no lost data). For the three to five places where a bug
would hurt most, write down the property and where it comes from.

Oracles, cheapest first:

| Oracle | Example |
|---|---|
| Crash | valid input makes the code throw, die or hang (`timeout`) |
| Round trip | `decode(encode(x))` equals `x`; `parse(print(x))` equals `x` |
| Built from parts | build the input from parts, and require the code to give the parts back |
| Reference | a simple, obviously correct implementation; another dialect; an older version |
| Invariant | sorted, balanced, nothing lost or duplicated, totals conserved, after every step |
| Metamorphic | two inputs that must give the same answer: with and without a rewrite, an index, a wrapper |

## 2. Write the generator

- Valid by construction, from the grammar or the types. No filtering.
- Simplest alternative first, so shrinking ends somewhere readable.
- Mix in what the code looks for: its keywords, boundary values, the fixture's
  own values. A random string almost never equals anything.
- For state, generate sequences of commands with `Stateful.commands`.
- Run `Inspect.inspect` on it with `valid`, `label` and `expect`. A generator
  that discards, builds invalid values or never produces a case finds nothing.

## 3. Run

Start with `prop` and the default search. Once it passes a quick run:

- Raise the budget: `PROP_SCALE=50`, or `PROP_BUDGET_MS`.
- Ask for every distinct failure, not the first: `PROP_FAILURES=10`. If they all
  share one signature, name the causes with `Prop.signature`.
- Add `Search.coverage` with `Coverage.layer` over the code under test. Run
  with `PROP_VERBOSE=1`: the functions the report says no input reached are
  where to aim the generator next. Widen it and run again.

## 4. When a property fails

1. Replay it with the `PROP_REPLAY` value from the report.
2. Decide whose bug it is:

   | Verdict | Signs | Action |
   |---|---|---|
   | Real bug | The input is valid by the docs, and the result contradicts a sentence you can quote | Fix it, or report it with the shrunk input |
   | Test bug | The generator built something invalid, or the oracle is wrong | Fix the test and run again |
   | Intended | The docs or an existing test say so | Narrow the generator, with a comment saying why |

3. For a real bug: add a plain unit test of the shrunk input, fix the code, and
   pin the input in the property's `examples` so it is checked on every run.
4. Run again. A fixed bug often hid the next one.

## 5. Report

Say what you tested and against which oracle, each bug with its shrunk input
and verdict, what was fixed, and what the coverage report says is still unreached.

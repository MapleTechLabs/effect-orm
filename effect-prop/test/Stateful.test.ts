import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { Gen, Inspect, Prop, Stateful } from "../src/index"


/** A bounded queue that loses an element when it wraps around while full: the bug to find. */
class RingQueue {
	private readonly items: Array<number>
	private head = 0
	private count = 0
	constructor(private readonly capacity: number) {
		this.items = new Array<number>(capacity).fill(0)
	}
	push(value: number): void {
		this.items[(this.head + this.count) % this.capacity] = value
		// Bug: a push onto a full queue overwrites the oldest element but does not move the head.
		if (this.count < this.capacity) this.count++
	}
	pop(): number | undefined {
		if (this.count === 0) return undefined
		const value = this.items[this.head]!
		this.head = (this.head + 1) % this.capacity
		this.count--
		return value
	}
	get size(): number {
		return this.count
	}
}

type Model = ReadonlyArray<number>
type QueueCommand = Stateful.Command<Model, RingQueue> & { readonly show: string }
const CAPACITY = 3

const push = (value: number): QueueCommand => ({
	name: "push",
	show: `push(${value})`,
	// The model of a correct bounded queue: a push onto a full queue drops the oldest.
	next: (model) => [...model, value].slice(-CAPACITY),
	run: (queue) => Effect.sync(() => queue.push(value)),
})
const pop: QueueCommand = {
	name: "pop",
	show: "pop",
	next: (model) => model.slice(1),
	run: (queue, model) => Effect.sync(() => queue.pop() === model[0]),
}
const size: QueueCommand = { name: "size", show: "size", next: (model) => model, run: (queue, model) => Effect.sync(() => queue.size === model.length) }

const sequences = Stateful.commands<Model, QueueCommand>({
	initial: [],
	// Never pop an empty queue: commands are generated for the state they run in.
	command: (model) => (model.length === 0 ? Gen.oneOf(Gen.map(Gen.int(0, 9), push), Gen.constant(size)) : Gen.oneOf(Gen.map(Gen.int(0, 9), push), Gen.constant(pop), Gen.constant(size))),
})

describe("Stateful", () => {
	it("generates only commands valid for the state they run in", () => {
		for (const sequence of Gen.sample(sequences, { count: 300, size: 80 })) {
			let model: Model = []
			for (const command of sequence) {
				if (command.name === "pop") expect(model.length).toBeGreaterThan(0)
				model = command.next(model)
			}
		}
	})

	it("finds the overflow bug and shrinks it to the shortest sequence", async () => {
		const report = await Effect.runPromise(
			Prop.check(sequences, (sequence) => Stateful.run<Model, RingQueue, never, never>([], new RingQueue(CAPACITY), sequence), { runs: 3000, seed: 1, format: (s) => s.map((c) => c.show).join(", ") }),
		)
		expect(report.failures).toHaveLength(1)
		expect(report.failures[0]!.signature).toBe("command pop")
		// Fill the queue, overflow it by one, and the next pop returns the overwritten slot.
		expect(report.format(report.failures[0]!.value)).toBe("push(0), push(0), push(0), push(1), pop")
		expect(report.failures[0]!.message).toContain("command 5 (pop) returned false")
	})

	it("groups a failure after the commands by itself, not by the last command", async () => {
		// A counter that works: every command agrees with the model.
		type Step = Stateful.Command<number, { n: number }> & { readonly show: string }
		const add = (by: number): Step => ({ name: by > 0 ? "up" : "down", show: `${by}`, next: (m) => m + by, run: (counter, m) => Effect.sync(() => (counter.n += by) === m + by) })
		const steps = Stateful.commands<number, Step>({ initial: 0, command: () => Gen.map(Gen.element(1, -1), add) })
		const report = await Effect.runPromise(
			Prop.check(
				steps,
				(sequence) => Effect.gen(function* () {
					yield* Stateful.run<number, { n: number }, never, never>(0, { n: 0 }, sequence)
					// An invariant of the whole run, wrong for any three commands.
					return sequence.length < 3
				}),
				{ runs: 2000, seed: 1, failures: 5 },
			),
		)
		expect(report.failures.map((f) => f.signature)).toEqual(["ReturnedFalse"])
		expect(report.failures[0]!.value.map((c) => c.show)).toEqual(["1", "1", "1"])
	})

	it("reports each command once per sequence it appears in", async () => {
		const report = await Effect.runPromise(Prop.check(sequences, (sequence) => Stateful.run<Model, RingQueue, never, never>([], new RingQueue(1000), sequence), { runs: 300, seed: 2 }))
		for (const count of Object.values(report.labels)) expect(count).toBeLessThanOrEqual(300)
		expect(Object.keys(report.labels).sort()).toEqual(["pop", "push", "size"])
	})
})

describe("Inspect", () => {
	it("passes a healthy generator and counts its labels", () => {
		const result = Inspect.inspect(Gen.array(Gen.int(0, 100)), { valid: (xs) => xs.every((x) => x >= 0), label: (xs) => (xs.length === 0 ? "empty" : "non-empty"), expect: ["empty", "non-empty"] })
		expect(result.problems).toEqual([])
		expect(result.generated).toBe(2000)
		expect(result.labels.empty! + result.labels["non-empty"]!).toBe(2000)
		expect(result.distinct).toBeGreaterThan(500)
	})

	it("names what is wrong with a generator", () => {
		const filtered = Inspect.inspect(Gen.int(0, 1000).pipe(Gen.filter((n) => n % 50 === 0)))
		expect(filtered.problems).toEqual([expect.stringMatching(/^\d+% of tries are discarded/)])
		const invalid = Inspect.inspect(Gen.int(-5, 5), { valid: (n) => n >= 0 })
		expect(invalid.problems).toEqual([expect.stringMatching(/^\d+ of 2000 values are invalid, for example -\d$/)])
		const narrow = Inspect.inspect(Gen.map(Gen.int(), (n) => ({ kind: n % 2 === 0 ? "a" : "b" })), { label: (v) => v.kind, expect: ["a", "b", "c"] })
		expect(narrow.problems).toEqual(["never produced: c"])
		expect(narrow.distinct).toBe(2)
		expect(Inspect.inspect(Gen.int().pipe(Gen.filter(() => false)), { samples: 50 }).problems).toEqual(["every one of 50 tries was discarded"])
		expect(Inspect.inspect(Gen.boolean).problems).toEqual([])
		expect(Inspect.inspect(Gen.map(Gen.int(), () => "x"), { samples: 10 }).problems).toEqual(['all 10 values are the same: "x"'])
	})
})

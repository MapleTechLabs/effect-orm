// The migration graph: what `check` validates and what `generate` diffs against.
//
// Mirrors drizzle-kit's `check`. Branches that touch different objects are
// commutative: the database ends up the same whichever lands first, so the
// next `generate` diffs against both merged and records both leaves as
// parents. Branches that touch the same object conflict, and one of them has
// to be regenerated on top of the other.

import { Effect } from "effect"
import { canonicalJson, entityKey, ORIGIN_ID, sha256Hex, sortEntities, type SchemaEntity } from "../schema/entities"
import { migrationParents, type LoadedMigration } from "../migrate/source"

export interface GraphProblem {
	readonly migration: string
	readonly message: string
}

export interface GraphAnalysis {
	readonly problems: ReadonlyArray<GraphProblem>
	/** Migrations nothing builds on yet. More than one means unmerged branches. */
	readonly leaves: ReadonlyArray<LoadedMigration>
	/** The schema the next migration starts from. */
	readonly base: ReadonlyArray<SchemaEntity>
	/** Parents for the next migration's snapshot. */
	readonly baseIds: ReadonlyArray<string>
}

const ancestorsOf = (
	m: LoadedMigration,
	parents: ReadonlyMap<LoadedMigration, ReadonlyArray<LoadedMigration>>,
): Set<LoadedMigration> => {
	const seen = new Set<LoadedMigration>()
	const stack = [m]
	while (stack.length > 0) {
		const next = stack.pop()!
		if (seen.has(next)) continue
		seen.add(next)
		stack.push(...(parents.get(next) ?? []))
	}
	return seen
}

/** Entity changes from `from` to `to`: key -> new entity, or null for removed. */
const changesBetween = (
	from: ReadonlyArray<SchemaEntity>,
	to: ReadonlyArray<SchemaEntity>,
): Map<string, SchemaEntity | null> => {
	const before = new Map(from.map((e) => [entityKey(e), canonicalJson(e)]))
	const after = new Map(to.map((e) => [entityKey(e), e]))
	const out = new Map<string, SchemaEntity | null>()
	for (const [key, entity] of after) if (before.get(key) !== canonicalJson(entity)) out.set(key, entity)
	for (const key of before.keys()) if (!after.has(key)) out.set(key, null)
	return out
}

/** The table an entity belongs to, so two branches editing one table conflict. */
const ownerOf = (key: string): string => {
	const [kind, rest = ""] = key.split(":")
	return kind === "column" || kind === "index" ? `table:${rest.split(".")[0]}` : key
}

export const analyze = (migrations: ReadonlyArray<LoadedMigration>): Effect.Effect<GraphAnalysis> =>
	Effect.gen(function* () {
		const problems: Array<GraphProblem> = []
		const withSnapshots = migrations.filter((m) => m.snapshot !== undefined)
		for (const m of migrations) {
			if (m.snapshot === undefined) problems.push({ migration: m.name, message: "has no snapshot.json" })
		}
		const knownIds = new Set(withSnapshots.map((m) => m.snapshot!.id))
		for (const m of withSnapshots) {
			const id = yield* Effect.promise(() => sha256Hex(canonicalJson(sortEntities(m.snapshot!.entities))))
			if (id !== m.snapshot!.id) {
				problems.push({ migration: m.name, message: "snapshot id does not match its entities; the snapshot was edited by hand" })
			}
		}
		const parents = migrationParents(withSnapshots)
		for (const m of withSnapshots) {
			for (const id of m.snapshot!.prevIds) {
				if (id === ORIGIN_ID) continue
				if (!knownIds.has(id)) problems.push({ migration: m.name, message: `parent snapshot ${id.slice(0, 12)} is not in the folder` })
				else if (!(parents.get(m) ?? []).some((p) => p.snapshot!.id === id)) {
					problems.push({
						migration: m.name,
						message: `sorts before its parent ${id.slice(0, 12)}; rename the folder so its timestamp is later`,
					})
				}
			}
		}

		// A broken chain makes leaves and ancestors meaningless; report it alone.
		if (problems.length > 0) return { problems, leaves: [], base: [], baseIds: [] }

		const hasChild = new Set<LoadedMigration>()
		for (const list of parents.values()) for (const p of list) hasChild.add(p)
		const leaves = withSnapshots.filter((m) => !hasChild.has(m))

		if (leaves.length === 0) return { problems, leaves, base: [], baseIds: [ORIGIN_ID] }
		if (leaves.length === 1) {
			const leaf = leaves[0]!
			return { problems, leaves, base: leaf.snapshot!.entities, baseIds: [leaf.snapshot!.id] }
		}

		// Several leaves: merge them on their nearest common ancestor.
		const ancestorSets = leaves.map((leaf) => ancestorsOf(leaf, parents))
		const common = withSnapshots.filter((m) => ancestorSets.every((set) => set.has(m)))
		const ancestor = common.reduce<LoadedMigration | undefined>(
			(best, m) => (best === undefined || ancestorsOf(m, parents).size > ancestorsOf(best, parents).size ? m : best),
			undefined,
		)
		const ancestorEntities = ancestor?.snapshot!.entities ?? []
		const merged = new Map(ancestorEntities.map((e) => [entityKey(e), e] as const))
		const touchedBy = new Map<string, string>()
		for (const leaf of leaves) {
			for (const [key, entity] of changesBetween(ancestorEntities, leaf.snapshot!.entities)) {
				const owner = ownerOf(key)
				const other = touchedBy.get(owner)
				if (other !== undefined && other !== leaf.name) {
					problems.push({
						migration: leaf.name,
						message: `conflicts with ${other}: both change ${owner.replace(":", " ")}. Delete one and generate it again on top of the other`,
					})
				}
				touchedBy.set(owner, leaf.name)
				if (entity === null) merged.delete(key)
				else merged.set(key, entity)
			}
		}
		return { problems, leaves, base: [...merged.values()], baseIds: leaves.map((l) => l.snapshot!.id) }
	})

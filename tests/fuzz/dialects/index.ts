// The dialect registry. Every fuzz suite iterates it; add a dialect here.
import { clickhouse } from "./clickhouse"
import { postgres } from "./postgres"
import type { FuzzDialect, FuzzTarget } from "./types"

export const dialects: ReadonlyArray<FuzzDialect> = [clickhouse, postgres]

/** Every target, with the dialect whose SQL it runs. */
export const targets: ReadonlyArray<{ readonly dialect: FuzzDialect; readonly target: FuzzTarget }> = dialects.flatMap((dialect) =>
	dialect.targets.map((target) => ({ dialect, target })),
)

/** Close whatever the targets opened; call from `afterAll`. */
export const closeAll = async (): Promise<void> => {
	await Promise.all(dialects.map((dialect) => dialect.close?.()))
}

export type { FuzzDialect, FuzzTarget, Outcome, Semantics } from "./types"

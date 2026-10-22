// Contexts for compiling plans.
//
// `contexts` are the core suite's: the fixture tables are CTEs over literal
// rows, so the same plan runs on every database. Those CTEs are bare SQL the
// builder cannot see into, and a CTE named `orders` shadows the `orders` table,
// so a query compiled against them never reports a meaningful tenant scope.
//
// `scopeContexts` compile the same plan against the plain tables, with no CTEs:
// the tenant scope the builder reports there is the one a real application
// gets, and the tenant oracle checks it against the rows the model says the
// query actually read.
import * as CH from "@maple-dev/effect-orm/clickhouse"
import { contexts as core, type CoreContext, type DialectName } from "../core-cases"

export const contexts: Record<DialectName, CoreContext> = core

export const scopeContexts: Record<DialectName, CoreContext> = {
	clickhouse: { ...core.clickhouse, from: (table) => CH.from(table) as any },
	postgres: { ...core.postgres, from: (table) => CH.from(table) as any },
}

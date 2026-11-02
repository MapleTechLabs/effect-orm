// Expressions in DDL: defaults, index keys and predicates, written with the
// query DSL or as SQL strings, and rendered once with the dialect the table is
// for. Shared by the Postgres and SQLite `table`.

import { compile as compileFragment } from "../sql/sql-fragment"
import { withDialect, type Dialect } from "../ch/dialect"
import type { Condition, Expr } from "../ch/expr"
import { createColumnAccessor, type ColumnAccessor } from "../ch/query"
import { columnSqlName, type ColumnDefs } from "../ch/types"
import type { DdlExpr, DdlKey } from "./define"

/** A partial index's predicate: SQL, or a condition built with the DSL. */
export type DdlPredicate<Cols extends ColumnDefs> = string | (($: ColumnAccessor<Cols>) => Condition | Expr<any> | string)

export interface DdlRenderer {
	/** SQL as written, or a DSL value rendered with the dialect. */
	readonly value: (value: Expr<any> | Condition | string) => string
	readonly expr: <Cols extends ColumnDefs>(expr: DdlExpr<Cols> | DdlPredicate<Cols>, columns: Cols) => string
	/** Key parts: a column name is written quoted, an expression as it renders. */
	readonly keyParts: <Cols extends ColumnDefs>(key: DdlKey<Cols>, columns: Cols) => ReadonlyArray<string>
}

export const ddlRenderer = (dialect: Dialect): DdlRenderer => {
	const value = (v: Expr<any> | Condition | string): string =>
		typeof v === "string" ? v : withDialect(dialect, () => compileFragment(v.toFragment()))
	return {
		value,
		expr: (expr, columns) => (typeof expr === "string" ? expr : value(expr(createColumnAccessor(columns)))),
		keyParts: (key, columns) =>
			typeof key === "function"
				? key(createColumnAccessor(columns)).map(value)
				: key.map((column) => dialect.quoteIdent(columnSqlName(columns, column))),
	}
}

import { makeExpr, toFragment } from "../expr"
import { compile } from "../../sql/sql-fragment"
import type { Expr, ParamsIn } from "../expr"
import { schemaOf } from "../define-fn"
import { QueryBuilderError } from "../errors"
import { builtins } from "./builtin"

const { lazy } = builtins("clickhouse", "scalar")
const window = builtins("clickhouse", "window")

export type WindowOrderDirection = "asc" | "desc"

export type WindowFrameBound<P = never> =
	| { readonly type: "CurrentRow" }
	| { readonly type: "UnboundedPreceding" }
	| { readonly type: "UnboundedFollowing" }
	| { readonly type: "Preceding"; readonly value: number | Expr<number, P> }
	| { readonly type: "Following"; readonly value: number | Expr<number, P> }

export interface WindowRowsFrame<P = never> {
	readonly type: "RowsBetween"
	readonly start: WindowFrameBound
	readonly end: WindowFrameBound
	/** phantom: the `param.*` placeholders in the bounds. */
	readonly _params?: (entries: P) => void
}

export interface WindowSpec {
	readonly partitionBy?: readonly Expr<any>[]
	readonly orderBy?: readonly Readonly<[Expr<any>, WindowOrderDirection]>[]
	readonly frame?: WindowRowsFrame
}

export interface CompiledWindowSpec<P = never> {
	readonly _brand: "WindowSpec"
	readonly sql: string
	/** phantom: the `param.*` placeholders in the spec. */
	readonly _params?: (entries: P) => void
}

/** The params of a window spec's partition, order and frame expressions. */
type SpecParams<S extends WindowSpec> =
	| ParamsIn<NonNullable<S["partitionBy"]>[number]>
	| ParamsIn<NonNullable<S["orderBy"]>[number][0]>
	| ParamsIn<S["frame"]>

export const currentRow: WindowFrameBound = { type: "CurrentRow" }
export const unboundedPreceding: WindowFrameBound = { type: "UnboundedPreceding" }
export const unboundedFollowing: WindowFrameBound = { type: "UnboundedFollowing" }

export function preceding<Q = never>(value: number | Expr<number, Q>): WindowFrameBound<Q> {
	return { type: "Preceding", value }
}

export function following<Q = never>(value: number | Expr<number, Q>): WindowFrameBound<Q> {
	return { type: "Following", value }
}

export function rowsBetween<Q1 = never, Q2 = never>(
	start: WindowFrameBound<Q1>,
	end: WindowFrameBound<Q2>,
): WindowRowsFrame<Q1 | Q2> {
	return { type: "RowsBetween", start, end }
}

export function windowSpec<const S extends WindowSpec>(spec: S): CompiledWindowSpec<SpecParams<S>> {
	if (!spec.partitionBy?.length && !spec.orderBy?.length && !spec.frame) {
		throw new QueryBuilderError({
			code: "InvalidArguments",
			message: "windowSpec requires at least one of partitionBy, orderBy or frame",
		})
	}
	return {
		_brand: "WindowSpec",
		get sql() {
			return renderWindowSpec(spec)
		},
	}
}

function renderWindowSpec(spec: WindowSpec): string {
	const parts: string[] = []

	if (spec.partitionBy && spec.partitionBy.length > 0) {
		parts.push(`PARTITION BY ${spec.partitionBy.map((expr) => compile(expr.toFragment())).join(", ")}`)
	}

	if (spec.orderBy && spec.orderBy.length > 0) {
		const orderBy = spec.orderBy
			.map(([expr, direction]) => `${compile(expr.toFragment())} ${direction.toUpperCase()}`)
			.join(", ")
		parts.push(`ORDER BY ${orderBy}`)
	}

	if (spec.frame) parts.push(compileRowsFrame(spec.frame))

	return parts.join(" ")
}

export function over<T, Q1 = never, Q2 = never>(expr: Expr<T, Q1>, spec: CompiledWindowSpec<Q2>): Expr<T, Q1 | Q2> {
	// A window changes which rows feed the value, never how the value decodes.
	return makeExpr(window.lazy(() => `${compile(expr.toFragment())} OVER (${spec.sql})`), schemaOf<T>(expr))
}

export function lagInFrame<T, Q1 = never, Q2 = never, Q3 = never>(
	expr: Expr<T, Q1>,
	offset: number | Expr<number, Q2>,
	defaultValue: T | Expr<T, Q3>,
): Expr<T, Q1 | Q2 | Q3> {
	return makeExpr(
		lazy(() =>
			`lagInFrame(${compile(expr.toFragment())}, ${compile(toFragment(offset))}, ${compile(toFragment(defaultValue))})`,
		),
		schemaOf<T>(expr),
	)
}

function compileRowsFrame(frame: WindowRowsFrame): string {
	return `ROWS BETWEEN ${compileFrameBound(frame.start)} AND ${compileFrameBound(frame.end)}`
}

function compileFrameBound(bound: WindowFrameBound): string {
	switch (bound.type) {
		case "CurrentRow":
			return "CURRENT ROW"
		case "UnboundedPreceding":
			return "UNBOUNDED PRECEDING"
		case "UnboundedFollowing":
			return "UNBOUNDED FOLLOWING"
		case "Preceding":
			return `${compile(toFragment(bound.value))} PRECEDING`
		case "Following":
			return `${compile(toFragment(bound.value))} FOLLOWING`
	}
}

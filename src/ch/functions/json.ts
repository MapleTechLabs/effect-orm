import type { Expr } from "../expr"
import * as T from "../types"
import { builtins } from "./builtin"

const { defineFn } = builtins("clickhouse", "scalar")

export const toJSONString = defineFn<[Expr<any>], string>("toJSONString", T.string)

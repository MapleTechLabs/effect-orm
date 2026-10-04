// Internal barrel for this package's own tests: the `/clickhouse` entry plus
// the bare `table()` its `table` builds on. Not published; consumers define
// tables with `table` from `/clickhouse` or `/postgres`.

export * from "../clickhouse"
export { table, type TableOptions } from "./table"

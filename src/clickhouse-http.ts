// @maple-dev/effect-orm/clickhouse-http
//
// A ClickHouse `SqlClient` over Effect's `HttpClient`: runs wherever `fetch`
// does, Cloudflare Workers included, where `@effect/sql-clickhouse` (Node only)
// cannot. Give it to `Database` like any other `SqlClient`. See
// docs/running-queries.md.

export {
	ClickhouseHttpClient,
	layer,
	make,
	type ClickhouseHttpClientConfig,
	type ClickhouseSetting,
} from "./clickhouse-http/client"

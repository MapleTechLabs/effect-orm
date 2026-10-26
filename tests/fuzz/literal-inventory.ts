// Each public runtime export from the type modules is a literal case or an
// explicit non-literal exemption. Registry tests reject new omissions and stale entries.
export const literalCoverage = {
	clickhouse: {
		string: "String", uint8: "UInt8", uint16: "UInt16", uint32: "UInt32", uint64: "UInt64",
		int32: "Int32", int64: "Int64", float64: "Float64", bool: "Bool",
		dateTime: "DateTime", dateTime64: "DateTime64", dateTimeString: "DateTimeString", dateTime64String: "DateTime64String",
		array: "Array(String)", nullable: "Nullable(String)", map: "Map(String, String)",
		lowCardinality: "LowCardinality(String)", simpleAggregateFunction: "SimpleAggregateFunction(max, Int64)",
		precision: "DateTime64(0)", brand: "brand(String)", custom: "custom(Int32)",
	},
	postgres: {
		text: "text", uuid: "uuid", bool: "boolean", int2: "int2", int4: "int4", int8: "int8",
		float4: "float4", float8: "float8", numeric: "numeric", timestamptz: "timestamptz", timestamptzMillis: "timestamptzMillis",
		jsonb: "jsonb", array: "text[]", nullable: "nullable(text)", brand: "brand(text)", custom: "custom(int4)",
	},
	sqlite: {
		text: "text", integer: "integer", real: "real", boolean: "boolean", timestamp: "timestamp", blob: "blob",
		json: "json", nullable: "nullable(text)", brand: "brand(text)", custom: "custom(text)",
	},
} as const

export const literalExemptions = {
	clickhouse: {
		CHNumber: "Wire codec; numeric literal cases exercise it with database-generated wire values.",
		aggregateState: "Opaque aggregate state is consumed by Merge, never a client literal.",
		untyped: "Caller-defined SQL with no value validation contract; custom has a representative typed extension case.",
	},
	postgres: {
		PgNumber: "Wire codec; numeric literal cases exercise it with database-generated wire values.",
		PgTimestampLiteral: "Timestamp literal codec; timestamptz literal cases exercise it.",
		parsePgArrayLiteral: "Driver wire-array parser, not a descriptor.",
		pgTimestampToIso: "Timestamp parsing helper, not a descriptor.",
		timestampLiteral: "Timestamp codec factory, not a descriptor.",
	},
	sqlite: {
		sqliteTimestampText: "Timestamp formatting helper, not a descriptor.",
		timestampNow: "SQL default expression, not a descriptor.",
	},
} as const

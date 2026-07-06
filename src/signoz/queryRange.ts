export const queryRangeEndpoint = "/api/v5/query_range";
export const signozTracesSource = "signoz_traces.distributed_signoz_index_v3";

export type QueryRangeRequestType = "raw";
export type QueryRangeSignal = "traces" | "logs";
export type RelativeDurationUnit = "s" | "m" | "h" | "d";

export type TimeRange = {
  start: number;
  end: number;
};

export type QueryRangePayload = {
  start: number;
  end: number;
  requestType: QueryRangeRequestType;
  compositeQuery: {
    queries: SigNozCompositeQuery[];
  };
};

export type SigNozCompositeQuery = {
  type: "builder_query";
  spec: SigNozBuilderQuerySpec;
};

export type SigNozFilterOperator = "=" | "!=" | ">" | ">=" | "<" | "<=";

export type SigNozBuilderQuerySpec = {
  name: string;
  signal: QueryRangeSignal;
  source?: string;
  disabled: false;
  filter: {
    expression: string;
  };
  selectFields: [];
  limit: number;
  offset: 0;
};

export type TraceSearchQueryOptions = {
  serviceName?: string;
  filterExpression?: string;
  route?: string;
  statusExpression?: string;
  minDurationMs?: number;
  since?: string;
  limit?: number;
  now?: number;
};

export type TraceLogsQueryOptions = {
  traceId: string;
  since?: string;
  limit?: number;
  now?: number;
};

export type TraceInspectQueryOptions = TraceLogsQueryOptions;

export type ServicesListQueryOptions = {
  since?: string;
  limit?: number;
  now?: number;
};

export type RawQueryRangeOptions = {
  signal: QueryRangeSignal;
  source?: string | undefined;
  filterExpression: string;
  since?: string | undefined;
  limit?: number | undefined;
  now?: number | undefined;
};

const defaultSince = "30m";
const defaultLimit = 20;
const queryName = "A";

const filterKeys = {
  serviceName: "service.name",
  route: "http.route",
  httpStatusCode: "http.response.status_code",
  durationNano: "duration_nano",
  traceId: "trace_id",
} as const;

export function parseRelativeDuration(duration: string): number {
  const match = /^([1-9]\d*)([smhd])$/.exec(duration.trim());

  if (match === null) {
    throw new Error(`Unsupported relative duration: ${duration}`);
  }

  const amountText = match[1];
  const unit = match[2] as RelativeDurationUnit;

  return Number(amountText) * millisecondsPerUnit(unit);
}

export function epochMillisWindowSince(
  since: string = defaultSince,
  now: number = Date.now(),
): TimeRange {
  const durationMs = parseRelativeDuration(since);

  return {
    start: now - durationMs,
    end: now,
  };
}

export function buildFailedTracesSearchQueryRange(
  options: TraceSearchQueryOptions,
): QueryRangePayload {
  return buildTracesSearchQueryRange(options);
}

export function buildTracesSearchQueryRange(
  options: TraceSearchQueryOptions,
): QueryRangePayload {
  const expressions: string[] = [];

  if (options.filterExpression !== undefined) {
    expressions.push(options.filterExpression);
  }

  if (options.serviceName !== undefined) {
    expressions.push(
      safeEqualityExpression(filterKeys.serviceName, options.serviceName),
    );
  }

  if (options.route !== undefined) {
    expressions.push(safeEqualityExpression(filterKeys.route, options.route));
  }

  if (options.statusExpression !== undefined) {
    expressions.push(parseStatusExpression(options.statusExpression));
  }

  if (options.minDurationMs !== undefined) {
    expressions.push(
      `${filterKeys.durationNano} >= ${options.minDurationMs * 1_000_000}`,
    );
  }

  return buildRawQueryRange({
    signal: "traces",
    source: signozTracesSource,
    filterExpression: andExpression(expressions),
    since: options.since,
    limit: options.limit,
    now: options.now,
  });
}

export function buildTraceLogsQueryRange(
  options: TraceLogsQueryOptions,
): QueryRangePayload {
  return buildRawQueryRange({
    signal: "logs",
    filterExpression: safeEqualityExpression(
      filterKeys.traceId,
      options.traceId,
    ),
    since: options.since,
    limit: options.limit,
    now: options.now,
  });
}

export function buildTraceInspectQueryRange(
  options: TraceInspectQueryOptions,
): QueryRangePayload {
  return buildRawQueryRange({
    signal: "traces",
    source: signozTracesSource,
    filterExpression: safeEqualityExpression(
      filterKeys.traceId,
      options.traceId,
    ),
    since: options.since,
    limit: options.limit,
    now: options.now,
  });
}

export function buildServicesListQueryRange(
  options: ServicesListQueryOptions = {},
): QueryRangePayload {
  return buildRawQueryRange({
    signal: "traces",
    source: signozTracesSource,
    filterExpression: `${filterKeys.serviceName} != ''`,
    since: options.since,
    limit: options.limit,
    now: options.now,
  });
}

export function buildRawQueryRange(
  options: RawQueryRangeOptions,
): QueryRangePayload {
  const timeRange = epochMillisWindowSince(options.since, options.now);

  return buildQueryRangePayload({
    signal: options.signal,
    filterExpression: options.filterExpression,
    timeRange,
    limit: options.limit,
    ...(options.source === undefined ? {} : { source: options.source }),
  });
}

export function safeEqualityExpression(key: string, value: string): string {
  return `${key} = '${escapeFilterString(value)}'`;
}

export function logBodyContainsExpression(value: string): string {
  return `body contains '${escapeFilterString(value)}'`;
}

function buildQueryRangePayload(options: {
  signal: QueryRangeSignal;
  source?: string;
  filterExpression: string;
  timeRange: TimeRange;
  limit: number | undefined;
}): QueryRangePayload {
  const spec: SigNozBuilderQuerySpec = {
    name: queryName,
    signal: options.signal,
    disabled: false,
    filter: {
      expression: options.filterExpression,
    },
    selectFields: [],
    limit: options.limit ?? defaultLimit,
    offset: 0,
  };

  if (options.source !== undefined) {
    spec.source = options.source;
  }

  return {
    start: options.timeRange.start,
    end: options.timeRange.end,
    requestType: "raw",
    compositeQuery: {
      queries: [
        {
          type: "builder_query",
          spec,
        },
      ],
    },
  };
}

function parseStatusExpression(expression: string): string {
  const match = /^(=|!=|>=|<=|>|<)\s*(\d+)$/.exec(expression.trim());

  if (match === null) {
    throw new Error(`Unsupported HTTP status expression: ${expression}`);
  }

  const operator = match[1] as SigNozFilterOperator;
  const value = Number(match[2]);

  return `${filterKeys.httpStatusCode} ${operator} ${value}`;
}

function andExpression(expressions: string[]): string {
  return expressions.join(" AND ");
}

function escapeFilterString(value: string): string {
  return value.replaceAll("'", "\\'");
}

function millisecondsPerUnit(unit: RelativeDurationUnit): number {
  switch (unit) {
    case "s":
      return 1_000;
    case "m":
      return 60_000;
    case "h":
      return 3_600_000;
    case "d":
      return 86_400_000;
    default: {
      const exhaustiveCheck: never = unit;
      return exhaustiveCheck;
    }
  }
}

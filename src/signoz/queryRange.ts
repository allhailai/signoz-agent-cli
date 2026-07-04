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
  serviceName: string;
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
  const timeRange = epochMillisWindowSince(options.since, options.now);
  const expressions: string[] = [
    equalsStringExpression(filterKeys.serviceName, options.serviceName),
  ];

  if (options.route !== undefined) {
    expressions.push(equalsStringExpression(filterKeys.route, options.route));
  }

  if (options.statusExpression !== undefined) {
    expressions.push(parseStatusExpression(options.statusExpression));
  }

  if (options.minDurationMs !== undefined) {
    expressions.push(
      `${filterKeys.durationNano} >= ${options.minDurationMs * 1_000_000}`,
    );
  }

  return buildQueryRangePayload({
    signal: "traces",
    source: signozTracesSource,
    filterExpression: andExpression(expressions),
    timeRange,
    limit: options.limit,
  });
}

export function buildTraceLogsQueryRange(
  options: TraceLogsQueryOptions,
): QueryRangePayload {
  const timeRange = epochMillisWindowSince(options.since, options.now);

  return buildQueryRangePayload({
    signal: "logs",
    filterExpression: equalsStringExpression(
      filterKeys.traceId,
      options.traceId,
    ),
    timeRange,
    limit: options.limit,
  });
}

export function buildTraceInspectQueryRange(
  options: TraceInspectQueryOptions,
): QueryRangePayload {
  const timeRange = epochMillisWindowSince(options.since, options.now);

  return buildQueryRangePayload({
    signal: "traces",
    source: signozTracesSource,
    filterExpression: equalsStringExpression(
      filterKeys.traceId,
      options.traceId,
    ),
    timeRange,
    limit: options.limit,
  });
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

function equalsStringExpression(key: string, value: string): string {
  return `${key} = '${escapeFilterString(value)}'`;
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

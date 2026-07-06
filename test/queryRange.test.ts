import { describe, expect, it } from "vitest";

import {
  buildFailedTracesSearchQueryRange,
  buildLogsSearchQueryRange,
  buildRawQueryRange,
  buildServicesListQueryRange,
  buildTraceInspectQueryRange,
  buildTraceLogsQueryRange,
  buildTracesSearchQueryRange,
  epochMillisWindowSince,
  logBodyContainsExpression,
  parseRelativeDuration,
  queryRangeEndpoint,
  safeEqualityExpression,
  signozTracesSource,
  type QueryRangePayload,
  type SigNozBuilderQuerySpec,
} from "../src/signoz/queryRange.js";

describe("query_range builders", () => {
  it("exports the SigNoz query_range endpoint path", () => {
    expect(queryRangeEndpoint).toBe("/api/v5/query_range");
  });

  it("parses simple relative durations", () => {
    expect(parseRelativeDuration("30m")).toBe(1_800_000);
    expect(parseRelativeDuration("1h")).toBe(3_600_000);
    expect(parseRelativeDuration("45s")).toBe(45_000);
    expect(parseRelativeDuration("2d")).toBe(172_800_000);
  });

  it("rejects unsupported relative duration syntax", () => {
    expect(() => parseRelativeDuration("0m")).toThrow(
      "Unsupported relative duration",
    );
    expect(() => parseRelativeDuration("30 minutes")).toThrow(
      "Unsupported relative duration",
    );
  });

  it("converts relative durations to millisecond epoch windows", () => {
    expect(epochMillisWindowSince("30m", 1_700_000_000_000)).toEqual({
      start: 1_699_998_200_000,
      end: 1_700_000_000_000,
    });
  });

  it("builds failed trace search payloads with v0 builder filters", () => {
    const payload = buildFailedTracesSearchQueryRange({
      serviceName: "barry",
      route: "/webhooks/signoz",
      statusExpression: ">=400",
      minDurationMs: 250,
      since: "30m",
      limit: 7,
      now: 1_700_000_000_000,
    });
    const builderQuery = getOnlyBuilderQuery(payload);

    expect(payload.start).toBe(1_699_998_200_000);
    expect(payload.end).toBe(1_700_000_000_000);
    expect(payload.requestType).toBe("raw");
    expect(payload.compositeQuery.queries).toHaveLength(1);
    expect(payload.compositeQuery.queries[0]).toMatchObject({
      type: "builder_query",
      spec: {
        name: "A",
        signal: "traces",
      },
    });
    expect(builderQuery.signal).toBe("traces");
    expect(builderQuery.source).toBe(signozTracesSource);
    expect(builderQuery.disabled).toBe(false);
    expect(builderQuery.selectFields).toEqual([]);
    expect(builderQuery.limit).toBe(7);
    expect(builderQuery.offset).toBe(0);
    expect(builderQuery.filter.expression).toBe(
      "service.name = 'barry' AND http.route = '/webhooks/signoz' AND http.response.status_code >= 400 AND duration_nano >= 250000000",
    );
  });

  it("builds minimal failed trace search payloads with defaults", () => {
    const payload = buildFailedTracesSearchQueryRange({
      serviceName: "barry",
      now: 1_700_000_000_000,
    });
    const builderQuery = getOnlyBuilderQuery(payload);

    expect(payload.start).toBe(1_699_998_200_000);
    expect(builderQuery.name).toBe("A");
    expect(builderQuery.signal).toBe("traces");
    expect(builderQuery.source).toBe(signozTracesSource);
    expect(builderQuery.limit).toBe(20);
    expect(builderQuery.offset).toBe(0);
    expect(builderQuery.filter.expression).toBe("service.name = 'barry'");
  });

  it("builds trace search payloads from arbitrary filters", () => {
    const payload = buildTracesSearchQueryRange({
      filterExpression: "barry.agent_run_id = '4'",
      since: "2h",
      limit: 11,
      now: 1_700_000_000_000,
    });
    const builderQuery = getOnlyBuilderQuery(payload);

    expect(payload.start).toBe(1_699_992_800_000);
    expect(builderQuery.signal).toBe("traces");
    expect(builderQuery.source).toBe(signozTracesSource);
    expect(builderQuery.limit).toBe(11);
    expect(builderQuery.filter.expression).toBe("barry.agent_run_id = '4'");
  });

  it("builds raw query_range payloads for reusable builders", () => {
    const payload = buildRawQueryRange({
      signal: "logs",
      filterExpression: "service.name = 'barry'",
      since: "15m",
      limit: 9,
      now: 1_700_000_000_000,
    });
    const builderQuery = getOnlyBuilderQuery(payload);

    expect(payload).toMatchObject({
      start: 1_699_999_100_000,
      end: 1_700_000_000_000,
      requestType: "raw",
      compositeQuery: {
        queries: [
          {
            type: "builder_query",
            spec: {
              name: "A",
              signal: "logs",
              disabled: false,
              filter: {
                expression: "service.name = 'barry'",
              },
              selectFields: [],
              limit: 9,
              offset: 0,
            },
          },
        ],
      },
    });
    expect(builderQuery).not.toHaveProperty("source");
  });

  it("escapes single quotes in trace filter string values", () => {
    const payload = buildFailedTracesSearchQueryRange({
      serviceName: "barry's worker",
      route: "/webhooks/signoz's-test",
      now: 1_700_000_000_000,
    });
    const builderQuery = getOnlyBuilderQuery(payload);

    expect(builderQuery.filter.expression).toBe(
      "service.name = 'barry\\'s worker' AND http.route = '/webhooks/signoz\\'s-test'",
    );
  });

  it("builds safe equality expressions", () => {
    expect(safeEqualityExpression("service.name", "barry's worker")).toBe(
      "service.name = 'barry\\'s worker'",
    );
  });

  it("builds log body contains expressions", () => {
    expect(logBodyContainsExpression("hello 'world'")).toBe(
      "body contains 'hello \\'world\\''",
    );
  });

  it("builds log search payloads from direct filters", () => {
    const payload = buildLogsSearchQueryRange({
      filterExpression: "barry.agent_run_id = '4'",
      since: "2h",
      limit: 11,
      now: 1_700_000_000_000,
    });
    const builderQuery = getOnlyBuilderQuery(payload);

    expect(payload.start).toBe(1_699_992_800_000);
    expect(builderQuery.signal).toBe("logs");
    expect(builderQuery).not.toHaveProperty("source");
    expect(builderQuery.limit).toBe(11);
    expect(builderQuery.filter.expression).toBe("barry.agent_run_id = '4'");
  });

  it("builds log search payloads from contains text", () => {
    const payload = buildLogsSearchQueryRange({
      contains: "hello world",
      since: "2h",
      limit: 11,
      now: 1_700_000_000_000,
    });
    const builderQuery = getOnlyBuilderQuery(payload);

    expect(builderQuery.signal).toBe("logs");
    expect(builderQuery.filter.expression).toBe("body contains 'hello world'");
  });

  it("builds log search payloads from selected service", () => {
    const payload = buildLogsSearchQueryRange({
      serviceName: "control-tower-api",
      since: "30m",
      limit: 5,
      now: 1_700_000_000_000,
    });
    const builderQuery = getOnlyBuilderQuery(payload);

    expect(builderQuery.signal).toBe("logs");
    expect(builderQuery.filter.expression).toBe(
      "service.name = 'control-tower-api'",
    );
  });

  it("rejects unsupported HTTP status expressions", () => {
    expect(() =>
      buildFailedTracesSearchQueryRange({
        serviceName: "barry",
        statusExpression: "4xx",
      }),
    ).toThrow("Unsupported HTTP status expression");
  });

  it("builds correlated log search payloads by trace ID", () => {
    const payload = buildTraceLogsQueryRange({
      traceId: "abc123",
      since: "1h",
      limit: 3,
      now: 1_700_000_000_000,
    });
    const builderQuery = getOnlyBuilderQuery(payload);

    expect(payload.start).toBe(1_699_996_400_000);
    expect(payload.requestType).toBe("raw");
    expect(payload.compositeQuery.queries).toHaveLength(1);
    expect(payload.compositeQuery.queries[0]).toMatchObject({
      type: "builder_query",
      spec: {
        name: "A",
        signal: "logs",
      },
    });
    expect(builderQuery.signal).toBe("logs");
    expect(builderQuery).not.toHaveProperty("source");
    expect(builderQuery.disabled).toBe(false);
    expect(builderQuery.selectFields).toEqual([]);
    expect(builderQuery.limit).toBe(3);
    expect(builderQuery.offset).toBe(0);
    expect(builderQuery.filter.expression).toBe("trace_id = 'abc123'");
  });

  it("builds raw trace inspect payloads by trace ID", () => {
    const payload = buildTraceInspectQueryRange({
      traceId: "trace-abc",
      since: "2h",
      limit: 5,
      now: 1_700_000_000_000,
    });
    const builderQuery = getOnlyBuilderQuery(payload);

    expect(payload.start).toBe(1_699_992_800_000);
    expect(payload.requestType).toBe("raw");
    expect(builderQuery.signal).toBe("traces");
    expect(builderQuery.source).toBe(signozTracesSource);
    expect(builderQuery.limit).toBe(5);
    expect(builderQuery.filter.expression).toBe("trace_id = 'trace-abc'");
  });

  it("builds recent service discovery payloads from trace data", () => {
    const payload = buildServicesListQueryRange({
      since: "2h",
      limit: 100,
      now: 1_700_000_000_000,
    });
    const builderQuery = getOnlyBuilderQuery(payload);

    expect(payload.start).toBe(1_699_992_800_000);
    expect(payload.requestType).toBe("raw");
    expect(builderQuery.signal).toBe("traces");
    expect(builderQuery.source).toBe(signozTracesSource);
    expect(builderQuery.limit).toBe(100);
    expect(builderQuery.filter.expression).toBe("service.name != ''");
  });
});

function getOnlyBuilderQuery(
  payload: QueryRangePayload,
): SigNozBuilderQuerySpec {
  const builderQuery = payload.compositeQuery.queries[0]?.spec;

  if (builderQuery === undefined) {
    throw new Error("Expected builder query A");
  }

  return builderQuery;
}

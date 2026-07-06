import type { TraceRefRecord } from "../session/refStore.js";
import type { ParsedLogRow } from "../signoz/logRows.js";
import type { ServiceSummary } from "../signoz/serviceRows.js";
import type { ParsedTraceRow } from "../signoz/traceRows.js";

export type TraceSearchJsonOptions = {
  serviceName: string;
  route?: string;
  statusExpression: string;
  minDurationMs?: number;
  since: string;
  limit: number;
};

export type TraceSearchJsonResult = {
  ok: true;
  count: number;
  query: TraceSearchJsonOptions;
  traces: TraceSearchJsonTrace[];
};

export type ServicesListJsonOptions = {
  since: string;
  limit: number;
};

export type ServicesListJsonResult = {
  ok: true;
  count: number;
  query: ServicesListJsonOptions;
  services: ServiceSummary[];
};

type TraceSearchJsonTrace = TraceRefRecord & {
  attributes: Record<string, unknown>;
  spanName?: string;
};

export type TraceLookupJsonOptions = {
  traceIdOrRef: string;
  traceId: string;
  since: string;
  limit: number;
};

export type TraceInspectJsonResult = {
  ok: true;
  count: number;
  query: TraceLookupJsonOptions;
  summary: {
    traceId: string;
    spanCount: number;
    rootSpan?: ParsedTraceRow;
    firstSpan?: ParsedTraceRow;
    status?: string;
    method?: string;
    route?: string;
    durationMs?: number;
  };
  spans: ParsedTraceRow[];
};

export type TraceLogsJsonResult = {
  ok: true;
  count: number;
  query: TraceLookupJsonOptions;
  logs: ParsedLogRow[];
};

export function formatTraceSearchJson(
  rows: ParsedTraceRow[],
  refs: TraceRefRecord[],
  options: TraceSearchJsonOptions,
): string {
  const traces = refs.map((ref, index) => toJsonTrace(ref, rows[index]));
  const result: TraceSearchJsonResult = {
    ok: true,
    count: traces.length,
    query: options,
    traces,
  };

  return `${JSON.stringify(result)}\n`;
}

export function formatServicesListJson(
  services: ServiceSummary[],
  options: ServicesListJsonOptions,
): string {
  const result: ServicesListJsonResult = {
    ok: true,
    count: services.length,
    query: options,
    services,
  };

  return `${JSON.stringify(result)}\n`;
}

export function formatTraceInspectJson(
  spans: ParsedTraceRow[],
  options: TraceLookupJsonOptions,
): string {
  const result: TraceInspectJsonResult = {
    ok: true,
    count: spans.length,
    query: options,
    summary: summarizeTraceJson(options.traceId, spans),
    spans,
  };

  return `${JSON.stringify(result)}\n`;
}

export function formatTraceLogsJson(
  logs: ParsedLogRow[],
  options: TraceLookupJsonOptions,
): string {
  const result: TraceLogsJsonResult = {
    ok: true,
    count: logs.length,
    query: options,
    logs,
  };

  return `${JSON.stringify(result)}\n`;
}

function summarizeTraceJson(
  traceId: string,
  spans: ParsedTraceRow[],
): TraceInspectJsonResult["summary"] {
  const rootSpan = findRootSpan(spans);
  const firstSpan = spans[0];
  const summary: TraceInspectJsonResult["summary"] = {
    traceId,
    spanCount: spans.length,
  };
  const summarySpan = rootSpan ?? firstSpan;

  if (rootSpan !== undefined) {
    summary.rootSpan = rootSpan;
  }

  if (firstSpan !== undefined) {
    summary.firstSpan = firstSpan;
  }

  if (summarySpan?.statusCode !== undefined) {
    summary.status = summarySpan.statusCode.toString();
  } else if (summarySpan?.status !== undefined) {
    summary.status = summarySpan.status;
  }

  if (summarySpan?.method !== undefined) {
    summary.method = summarySpan.method;
  }

  if (summarySpan?.route !== undefined) {
    summary.route = summarySpan.route;
  }

  if (summarySpan?.durationMs !== undefined) {
    summary.durationMs = summarySpan.durationMs;
  }

  return summary;
}

function findRootSpan(spans: ParsedTraceRow[]): ParsedTraceRow | undefined {
  return spans.find(
    (span) =>
      span.parentSpanId === undefined ||
      span.parentSpanId === "" ||
      span.parentSpanId === "0000000000000000",
  );
}

function toJsonTrace(
  ref: TraceRefRecord,
  row: ParsedTraceRow | undefined,
): TraceSearchJsonTrace {
  const trace: TraceSearchJsonTrace = {
    ...ref,
    attributes: row?.attributes ?? {},
  };

  if (row?.spanName !== undefined) {
    trace.spanName = row.spanName;
  }

  return trace;
}

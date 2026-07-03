import type { TraceRefRecord } from "../session/refStore.js";
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

type TraceSearchJsonTrace = TraceRefRecord & {
  attributes: Record<string, unknown>;
  spanName?: string;
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

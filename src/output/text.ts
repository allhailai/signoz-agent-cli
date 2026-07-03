import type { TraceRefRecord } from "../session/refStore.js";

export type TraceSearchTextOptions = {
  serviceName: string;
  route?: string;
  since: string;
  jsonCommand: string;
};

export function formatTraceSearchText(
  traces: TraceRefRecord[],
  options: TraceSearchTextOptions,
): string {
  const lines = [formatTraceSearchHeader(traces.length, options), ""];

  for (const trace of traces) {
    lines.push(formatTraceLine(trace));
  }

  if (traces.length > 0) {
    lines.push("", "Next:");
    lines.push(`- signoz-agent trace inspect ${traces[0]?.ref ?? "@t1"}`);
    lines.push(`- signoz-agent trace logs ${traces[0]?.ref ?? "@t1"}`);
    lines.push(`- ${options.jsonCommand}`);
  } else {
    lines.push("Next:");
    lines.push("- widen --since or relax --status/--route filters");
    lines.push(`- ${options.jsonCommand}`);
  }

  return `${lines.join("\n")}\n`;
}

function formatTraceSearchHeader(
  count: number,
  options: TraceSearchTextOptions,
): string {
  const parts = [
    `${count} failing ${count === 1 ? "trace" : "traces"}`,
    `for service=${options.serviceName}`,
  ];

  if (options.route !== undefined) {
    parts.push(`route=${options.route}`);
  }

  parts.push(`since=${options.since}`);

  return parts.join(" ");
}

function formatTraceLine(trace: TraceRefRecord): string {
  const status = trace.statusCode?.toString() ?? "status=?";
  const method = trace.method ?? "method=?";
  const route = trace.route ?? "route=?";
  const duration =
    trace.durationMs === undefined ? "?ms" : `${trace.durationMs}ms`;

  return `${trace.ref} ${status} ${method} ${route} ${duration} trace=${shortTraceId(trace.traceId)}`;
}

function shortTraceId(traceId: string): string {
  if (traceId.length <= 12) {
    return traceId;
  }

  return `${traceId.slice(0, 12)}...`;
}

import type { TraceRefRecord } from "../session/refStore.js";
import type { ParsedLogRow } from "../signoz/logRows.js";
import type { ServiceSummary } from "../signoz/serviceRows.js";
import type { ParsedTraceRow } from "../signoz/traceRows.js";

export type TraceSearchTextOptions = {
  filterExpression?: string;
  serviceName?: string;
  route?: string;
  since: string;
  jsonCommand: string;
};

export type ServicesListTextOptions = {
  since: string;
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
    lines.push("- widen --since or relax filters");
    lines.push(`- ${options.jsonCommand}`);
  }

  return `${lines.join("\n")}\n`;
}

export function formatTraceInspectText(
  traceId: string,
  spans: ParsedTraceRow[],
): string {
  const summary = summarizeTrace(traceId, spans);
  const lines = [
    `trace ${shortTraceId(traceId)} spans=${spans.length} status=${summary.status} method=${summary.method} route=${summary.route} duration=${summary.duration}`,
  ];

  if (summary.rootSpan !== undefined) {
    lines.push(`root ${formatSpanSummary(summary.rootSpan)}`);
  }

  if (spans.length > 0) {
    lines.push("", "Spans:");

    for (const span of spans.slice(0, 10)) {
      lines.push(`- ${formatSpanSummary(span)}`);
    }

    if (spans.length > 10) {
      lines.push(`- ... ${spans.length - 10} more`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function formatTraceLogsText(
  traceId: string,
  logs: ParsedLogRow[],
): string {
  const lines = [`${logs.length} logs for trace=${shortTraceId(traceId)}`];

  for (const log of logs) {
    const timestamp = log.timestamp ?? "time=?";
    const level = log.level ?? "level=?";
    const message = log.message ?? "message=?";

    lines.push(`${timestamp} ${level} ${message}`);
  }

  return `${lines.join("\n")}\n`;
}

export function formatServicesListText(
  services: ServiceSummary[],
  options: ServicesListTextOptions,
): string {
  const lines = [
    `${services.length} ${services.length === 1 ? "service" : "services"} since=${options.since}`,
    "",
  ];

  for (const service of services) {
    lines.push(formatServiceLine(service));
  }

  const firstService = services[0];

  if (firstService !== undefined) {
    lines.push("", "Next:");
    lines.push(
      `- signoz-agent services select ${shellToken(firstService.serviceName)}`,
    );
  } else {
    lines.push("Next:");
    lines.push("- widen --since");
  }

  return `${lines.join("\n")}\n`;
}

export function formatSelectedServiceText(serviceName: string): string {
  return `${serviceName}\n`;
}

function summarizeTrace(
  traceId: string,
  spans: ParsedTraceRow[],
): {
  traceId: string;
  spanCount: number;
  rootSpan?: ParsedTraceRow;
  status: string;
  method: string;
  route: string;
  duration: string;
} {
  const rootSpan = findRootSpan(spans);
  const firstSpan = rootSpan ?? spans[0];

  return {
    traceId,
    spanCount: spans.length,
    ...(rootSpan === undefined ? {} : { rootSpan }),
    status: formatStatus(firstSpan),
    method: firstSpan?.method ?? "?",
    route: firstSpan?.route ?? "?",
    duration:
      firstSpan?.durationMs === undefined ? "?" : `${firstSpan.durationMs}ms`,
  };
}

function findRootSpan(spans: ParsedTraceRow[]): ParsedTraceRow | undefined {
  return spans.find(
    (span) =>
      span.parentSpanId === undefined ||
      span.parentSpanId === "" ||
      span.parentSpanId === "0000000000000000",
  );
}

function formatSpanSummary(span: ParsedTraceRow): string {
  const name = span.spanName ?? "span=?";
  const service = span.serviceName ?? "service=?";
  const duration =
    span.durationMs === undefined ? "duration=?" : `${span.durationMs}ms`;

  return `${duration} ${formatStatus(span)} ${service} ${name}`;
}

function formatStatus(span: ParsedTraceRow | undefined): string {
  if (span?.statusCode !== undefined) {
    return span.statusCode.toString();
  }

  return span?.status ?? "?";
}

function formatTraceSearchHeader(
  count: number,
  options: TraceSearchTextOptions,
): string {
  const parts = [`${count} matching ${count === 1 ? "trace" : "traces"}`];

  if (options.filterExpression !== undefined) {
    parts.push(`for filter=${options.filterExpression}`);
  } else if (options.serviceName !== undefined) {
    parts.push(`for service=${options.serviceName}`);
  }

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

function formatServiceLine(service: ServiceSummary): string {
  const latest =
    service.latestTimestamp === undefined
      ? "latest=?"
      : `latest=${service.latestTimestamp}`;

  return `${service.serviceName} traces=${service.traceCount} errors=${service.errorCount} ${latest}`;
}

function shellToken(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shortTraceId(traceId: string): string {
  if (traceId.length <= 12) {
    return traceId;
  }

  return `${traceId.slice(0, 12)}...`;
}

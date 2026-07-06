import type { ParsedTraceRow } from "./traceRows.js";

export type ServiceSummary = {
  serviceName: string;
  traceCount: number;
  errorCount: number;
  latestTimestamp?: string;
};

type ServiceAccumulator = {
  serviceName: string;
  traceIds: Set<string>;
  errorTraceIds: Set<string>;
  latestTimestamp?: string;
};

export function summarizeServicesFromTraceRows(
  rows: ParsedTraceRow[],
  limit: number,
): ServiceSummary[] {
  const servicesByName = new Map<string, ServiceAccumulator>();

  for (const row of rows) {
    if (row.serviceName === undefined) {
      continue;
    }

    const summary = servicesByName.get(row.serviceName) ?? {
      serviceName: row.serviceName,
      traceIds: new Set<string>(),
      errorTraceIds: new Set<string>(),
    };

    summary.traceIds.add(row.traceId);

    if (isErrorTrace(row)) {
      summary.errorTraceIds.add(row.traceId);
    }

    if (isLaterTimestamp(row.timestamp, summary.latestTimestamp)) {
      summary.latestTimestamp = row.timestamp;
    }

    servicesByName.set(row.serviceName, summary);
  }

  return [...servicesByName.values()]
    .map(toServiceSummary)
    .sort(compareServiceSummaries)
    .slice(0, limit);
}

function toServiceSummary(accumulator: ServiceAccumulator): ServiceSummary {
  const summary: ServiceSummary = {
    serviceName: accumulator.serviceName,
    traceCount: accumulator.traceIds.size,
    errorCount: accumulator.errorTraceIds.size,
  };

  if (accumulator.latestTimestamp !== undefined) {
    summary.latestTimestamp = accumulator.latestTimestamp;
  }

  return summary;
}

function compareServiceSummaries(
  left: ServiceSummary,
  right: ServiceSummary,
): number {
  const countComparison = right.traceCount - left.traceCount;

  if (countComparison !== 0) {
    return countComparison;
  }

  return left.serviceName.localeCompare(right.serviceName);
}

function isErrorTrace(row: ParsedTraceRow): boolean {
  if (row.statusCode !== undefined) {
    return row.statusCode >= 400;
  }

  return row.status?.toLowerCase() === "error";
}

function isLaterTimestamp(
  candidate: string | undefined,
  current: string | undefined,
): candidate is string {
  if (candidate === undefined) {
    return false;
  }

  if (current === undefined) {
    return true;
  }

  return Date.parse(candidate) > Date.parse(current);
}

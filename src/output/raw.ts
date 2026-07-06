import type { SigNozResponse } from "../signoz/client.js";

export type RawQueryRangeDiagnostic = {
  ok: true;
  command: string;
  endpoint: string;
  request: unknown;
  httpStatus: number;
  responseShape: QueryRangeResponseShape;
};

export type QueryRangeResponseShape = {
  status: string | null;
  data: {
    type: string | null;
  };
  resultSetCount: number | null;
  rowCount: number | null;
  firstRowKeys: string[] | null;
};

export function formatRawQueryRangeDiagnostic(options: {
  command: string;
  endpoint: string;
  request: unknown;
  response: SigNozResponse;
}): string {
  const diagnostic: RawQueryRangeDiagnostic = {
    ok: true,
    command: options.command,
    endpoint: options.endpoint,
    request: options.request,
    httpStatus: options.response.status,
    responseShape: summarizeQueryRangeResponse(options.response.bodyJson),
  };

  return `${JSON.stringify(diagnostic)}\n`;
}

function summarizeQueryRangeResponse(body: unknown): QueryRangeResponseShape {
  const response = asRecord(body);
  const data = asRecord(response?.data);
  const nestedData = asRecord(data?.data);
  const results = Array.isArray(nestedData?.results)
    ? nestedData.results
    : null;
  const firstResult = asRecord(results?.[0]);
  const rows = firstResult === undefined ? undefined : firstResult.rows;

  return {
    status: stringOrNull(response?.status),
    data: {
      type: stringOrNull(data?.type),
    },
    resultSetCount: results === null ? null : results.length,
    rowCount: summarizeRowCount(rows),
    firstRowKeys: summarizeFirstRowKeys(rows),
  };
}

function summarizeRowCount(rows: unknown): number | null {
  if (rows === null) {
    return null;
  }

  if (Array.isArray(rows)) {
    return rows.length;
  }

  return null;
}

function summarizeFirstRowKeys(rows: unknown): string[] | null {
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  const firstRow = asRecord(rows[0]);

  if (firstRow === undefined) {
    return null;
  }

  return Object.keys(firstRow).sort();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

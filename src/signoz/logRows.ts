export type ParsedLogRow = {
  traceId?: string;
  timestamp?: string;
  level?: string;
  message?: string;
  attributes: Record<string, unknown>;
  raw: unknown;
};

export type RawLogRowsResult =
  | {
      ok: true;
      rows: ParsedLogRow[];
    }
  | {
      ok: false;
      message: string;
    };

type UnknownRecord = Record<string, unknown>;

export function parseRawLogRows(body: unknown): RawLogRowsResult {
  const response = asRecord(body);

  if (response === undefined || response.status !== "success") {
    return { ok: false, message: "SigNoz query_range did not return success" };
  }

  const data = asRecord(response.data);

  if (data?.type !== "raw") {
    return { ok: false, message: "SigNoz query_range did not return raw data" };
  }

  const rawData = asRecord(data.data);
  const firstResult = Array.isArray(rawData?.results)
    ? asRecord(rawData.results[0])
    : undefined;

  if (firstResult === undefined || firstResult.rows === undefined) {
    return { ok: false, message: "SigNoz query_range raw rows are missing" };
  }

  if (firstResult.rows === null) {
    return {
      ok: true,
      rows: [],
    };
  }

  if (!Array.isArray(firstResult.rows)) {
    return { ok: false, message: "SigNoz query_range raw rows are missing" };
  }

  return {
    ok: true,
    rows: firstResult.rows.map((row) => parseLogRow(row)),
  };
}

function parseLogRow(row: unknown): ParsedLogRow {
  const record = asRecord(row);
  const data = asRecord(record?.data);
  const attributes = {
    ...asRecord(record?.attributes),
    ...asRecord(data?.attributes),
    ...asRecord(record?.resources),
    ...asRecord(data?.resources),
  };
  const parsed: ParsedLogRow = {
    attributes,
    raw: row,
  };
  const traceId = firstString([
    record?.traceId,
    record?.trace_id,
    data?.traceId,
    data?.trace_id,
    attributes.traceId,
    attributes.trace_id,
  ]);
  const timestamp = firstStringOrNumber([
    record?.timestamp,
    record?.time,
    data?.timestamp,
    data?.time,
  ]);
  const level = firstString([
    record?.level,
    record?.severityText,
    record?.severity_text,
    data?.level,
    data?.severityText,
    data?.severity_text,
    attributes.level,
    attributes.severity,
    attributes.severityText,
    attributes.severity_text,
  ]);
  const message = firstString([
    record?.message,
    record?.body,
    data?.message,
    data?.body,
    attributes.message,
    attributes.body,
  ]);

  if (traceId !== undefined) {
    parsed.traceId = traceId;
  }

  if (timestamp !== undefined) {
    parsed.timestamp = timestamp;
  }

  if (level !== undefined) {
    parsed.level = level;
  }

  if (message !== undefined) {
    parsed.message = message;
  }

  return parsed;
}

function firstString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }

  return undefined;
}

function firstStringOrNumber(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return value.toString();
    }
  }

  return undefined;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as UnknownRecord;
}

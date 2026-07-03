export type ParsedTraceRow = {
  traceId: string;
  serviceName?: string;
  method?: string;
  route?: string;
  statusCode?: number;
  durationMs?: number;
  spanName?: string;
  timestamp?: string;
  attributes: Record<string, unknown>;
};

export type RawTraceRowsResult =
  | {
      ok: true;
      rows: ParsedTraceRow[];
    }
  | {
      ok: false;
      message: string;
    };

type UnknownRecord = Record<string, unknown>;

const attributeKeys = {
  serviceName: "service.name",
  method: "http.request.method",
  legacyMethod: "http.method",
  route: "http.route",
  target: "http.target",
  statusCode: "http.response.status_code",
  legacyStatusCode: "http.status_code",
} as const;

export function parseRawTraceRows(body: unknown): RawTraceRowsResult {
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
    rows: firstResult.rows.flatMap((row) => parseTraceRow(row)),
  };
}

function parseTraceRow(row: unknown): ParsedTraceRow[] {
  const record = asRecord(row);

  if (record === undefined) {
    return [];
  }

  const data = asRecord(record.data);
  const attributes = {
    ...asRecord(record.attributes),
    ...asRecord(data?.attributes),
  };
  const traceId = firstString([
    record.traceId,
    record.trace_id,
    record.traceID,
    data?.traceId,
    data?.trace_id,
    attributes.traceId,
    attributes.trace_id,
    traceIdFromLinks(record.links),
    traceIdFromLinks(data?.links),
  ]);

  if (traceId === undefined) {
    return [];
  }

  const parsed: ParsedTraceRow = {
    traceId,
    attributes,
  };
  const serviceName = firstString([attributes[attributeKeys.serviceName]]);
  const method = firstString([
    attributes[attributeKeys.method],
    attributes[attributeKeys.legacyMethod],
  ]);
  const route = firstString([
    attributes[attributeKeys.route],
    attributes[attributeKeys.target],
  ]);
  const statusCode = firstNumber([
    attributes[attributeKeys.statusCode],
    attributes[attributeKeys.legacyStatusCode],
    record.statusCode,
    record.status_code,
    data?.statusCode,
    data?.status_code,
  ]);
  const durationNano = firstNumber([
    record.duration_nano,
    record.durationNano,
    data?.duration_nano,
    data?.durationNano,
  ]);
  const spanName = firstString([record.name, record.spanName, data?.name]);
  const timestamp = firstString([
    record.timestamp,
    record.time,
    data?.timestamp,
    data?.time,
  ]);

  if (serviceName !== undefined) {
    parsed.serviceName = serviceName;
  }

  if (method !== undefined) {
    parsed.method = method;
  }

  if (route !== undefined) {
    parsed.route = route;
  }

  if (statusCode !== undefined) {
    parsed.statusCode = statusCode;
  }

  if (durationNano !== undefined) {
    parsed.durationMs = Math.round(durationNano / 1_000_000);
  }

  if (spanName !== undefined) {
    parsed.spanName = spanName;
  }

  if (timestamp !== undefined) {
    parsed.timestamp = timestamp;
  }

  return [parsed];
}

function traceIdFromLinks(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  for (const item of value) {
    const link = asRecord(item);
    const traceId = firstString([link?.traceId, link?.trace_id]);

    if (traceId !== undefined) {
      return traceId;
    }
  }

  return undefined;
}

function firstString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }

  return undefined;
}

function firstNumber(values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);

      if (Number.isFinite(parsed)) {
        return parsed;
      }
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

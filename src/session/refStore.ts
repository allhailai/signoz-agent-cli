import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ParsedTraceRow } from "../signoz/traceRows.js";

export type TraceRefRecord = {
  ref: string;
  traceId: string;
  serviceName?: string;
  method?: string;
  route?: string;
  statusCode?: number;
  durationMs?: number;
  timestamp?: string;
};

export type SessionFile = {
  version: 1;
  updatedAt: string;
  traces: TraceRefRecord[];
};

export type ResolveTraceRefResult =
  | {
      ok: true;
      traceId: string;
      ref?: TraceRefRecord;
    }
  | {
      ok: false;
      ref: string;
    };

const sessionDirectory = ".signoz-agent";
const sessionFileName = "session.json";

export async function writeTraceRefs(
  rows: ParsedTraceRow[],
  cwd: string = process.cwd(),
  now: Date = new Date(),
): Promise<TraceRefRecord[]> {
  const traces = rows.map((row, index) => toTraceRefRecord(row, index + 1));
  const session: SessionFile = {
    version: 1,
    updatedAt: now.toISOString(),
    traces,
  };
  const directory = join(cwd, sessionDirectory);

  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, sessionFileName),
    `${JSON.stringify(session, null, 2)}\n`,
    "utf8",
  );

  return traces;
}

export async function resolveTraceIdOrRef(
  traceIdOrRef: string,
  cwd: string = process.cwd(),
): Promise<ResolveTraceRefResult> {
  if (!traceIdOrRef.startsWith("@")) {
    return {
      ok: true,
      traceId: traceIdOrRef,
    };
  }

  const session = await readSessionFile(cwd);
  const ref = session?.traces.find((trace) => trace.ref === traceIdOrRef);

  if (ref === undefined) {
    return {
      ok: false,
      ref: traceIdOrRef,
    };
  }

  return {
    ok: true,
    traceId: ref.traceId,
    ref,
  };
}

async function readSessionFile(cwd: string): Promise<SessionFile | undefined> {
  let text: string;

  try {
    text = await readFile(join(cwd, sessionDirectory, sessionFileName), "utf8");
  } catch {
    return undefined;
  }

  try {
    const parsed = JSON.parse(text) as unknown;

    if (!isSessionFile(parsed)) {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
}

function isSessionFile(value: unknown): value is SessionFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return record.version === 1 && Array.isArray(record.traces);
}

function toTraceRefRecord(
  row: ParsedTraceRow,
  ordinal: number,
): TraceRefRecord {
  const record: TraceRefRecord = {
    ref: `@t${ordinal}`,
    traceId: row.traceId,
  };

  if (row.serviceName !== undefined) {
    record.serviceName = row.serviceName;
  }

  if (row.method !== undefined) {
    record.method = row.method;
  }

  if (row.route !== undefined) {
    record.route = row.route;
  }

  if (row.statusCode !== undefined) {
    record.statusCode = row.statusCode;
  }

  if (row.durationMs !== undefined) {
    record.durationMs = row.durationMs;
  }

  if (row.timestamp !== undefined) {
    record.timestamp = row.timestamp;
  }

  return record;
}

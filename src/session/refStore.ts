import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ParsedLogRow } from "../signoz/logRows.js";
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

export type LogRefRecord = {
  ref: string;
  timestamp?: string;
  traceId?: string;
  level?: string;
  message?: string;
  attributes: Record<string, unknown>;
};

export type SessionFile = {
  version: 1;
  updatedAt: string;
  traces: TraceRefRecord[];
  logs: LogRefRecord[];
  currentService?: string;
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
  const existingSession = await readSessionFile(cwd);
  const session: SessionFile = {
    version: 1,
    updatedAt: now.toISOString(),
    traces,
    logs: existingSession?.logs ?? [],
  };

  if (existingSession?.currentService !== undefined) {
    session.currentService = existingSession.currentService;
  }

  await writeSessionFile(session, cwd);

  return traces;
}

export async function writeLogRefs(
  rows: ParsedLogRow[],
  cwd: string = process.cwd(),
  now: Date = new Date(),
): Promise<LogRefRecord[]> {
  const logs = rows.map((row, index) => toLogRefRecord(row, index + 1));
  const existingSession = await readSessionFile(cwd);
  const session: SessionFile = {
    version: 1,
    updatedAt: now.toISOString(),
    traces: existingSession?.traces ?? [],
    logs,
  };

  if (existingSession?.currentService !== undefined) {
    session.currentService = existingSession.currentService;
  }

  await writeSessionFile(session, cwd);

  return logs;
}

export async function writeSelectedService(
  serviceName: string,
  cwd: string = process.cwd(),
  now: Date = new Date(),
): Promise<void> {
  const existingSession = await readSessionFile(cwd);
  const session: SessionFile = {
    version: 1,
    updatedAt: now.toISOString(),
    traces: existingSession?.traces ?? [],
    logs: existingSession?.logs ?? [],
    currentService: serviceName,
  };

  await writeSessionFile(session, cwd);
}

export async function readSelectedService(
  cwd: string = process.cwd(),
): Promise<string | undefined> {
  const session = await readSessionFile(cwd);

  return session?.currentService;
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

    return {
      ...parsed,
      logs: parsed.logs ?? [],
    };
  } catch {
    return undefined;
  }
}

async function writeSessionFile(
  session: SessionFile,
  cwd: string,
): Promise<void> {
  const directory = join(cwd, sessionDirectory);

  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, sessionFileName),
    `${JSON.stringify(session, null, 2)}\n`,
    "utf8",
  );
}

function isSessionFile(value: unknown): value is SessionFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    record.version === 1 &&
    Array.isArray(record.traces) &&
    (record.logs === undefined || Array.isArray(record.logs))
  );
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

function toLogRefRecord(row: ParsedLogRow, ordinal: number): LogRefRecord {
  const record: LogRefRecord = {
    ref: `@l${ordinal}`,
    attributes: row.attributes,
  };

  if (row.timestamp !== undefined) {
    record.timestamp = row.timestamp;
  }

  if (row.traceId !== undefined) {
    record.traceId = row.traceId;
  }

  if (row.level !== undefined) {
    record.level = row.level;
  }

  if (row.message !== undefined) {
    record.message = row.message;
  }

  return record;
}

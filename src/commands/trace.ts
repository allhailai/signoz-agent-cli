import { Command, InvalidArgumentError } from "commander";

import { ConfigError, loadConfig } from "../config.js";
import { formatTraceInspectJson, formatTraceLogsJson } from "../output/json.js";
import { formatTraceInspectText, formatTraceLogsText } from "../output/text.js";
import { resolveTraceIdOrRef } from "../session/refStore.js";
import {
  SigNozClient,
  SigNozNetworkError,
  type SigNozResponse,
} from "../signoz/client.js";
import { parseRawLogRows } from "../signoz/logRows.js";
import {
  buildTraceInspectQueryRange,
  buildTraceLogsQueryRange,
  queryRangeEndpoint,
} from "../signoz/queryRange.js";
import { parseRawTraceRows } from "../signoz/traceRows.js";

type TraceLookupOptions = {
  since: string;
  limit: number;
  json?: boolean;
};

type TraceFailure = {
  ok: false;
  command: "inspect" | "logs";
  code:
    | "missing_ref"
    | "missing_config"
    | "invalid_config"
    | "unreachable"
    | "signoz_error"
    | "unexpected_response";
  message: string;
  endpoint?: string;
  httpStatus?: number;
  missingVariables?: string[];
  ref?: string;
};

const defaultSince = "30m";
const defaultLimit = 20;

export function registerTraceCommand(program: Command): void {
  const trace = program
    .command("trace")
    .description("Inspect one SigNoz trace.");

  trace
    .command("inspect")
    .description("Inspect spans for a trace ID or session ref.")
    .argument("<trace-id-or-ref>", "Full trace ID or ref like @t1.")
    .option("--since <duration>", "Relative time window.", defaultSince)
    .option("--limit <n>", "Maximum spans to return.", parseLimit, defaultLimit)
    .option("--json", "Print structured JSON output.")
    .action(async (traceIdOrRef: string, options: TraceLookupOptions) => {
      const result = await runTraceInspect(traceIdOrRef, options);

      if (!result.ok) {
        writeFailure(result, options.json === true);
        process.exitCode = 1;
      }
    });

  trace
    .command("logs")
    .description("Find correlated logs for a trace ID or session ref.")
    .argument("<trace-id-or-ref>", "Full trace ID or ref like @t1.")
    .option("--since <duration>", "Relative time window.", defaultSince)
    .option(
      "--limit <n>",
      "Maximum log rows to return.",
      parseLimit,
      defaultLimit,
    )
    .option("--json", "Print structured JSON output.")
    .action(async (traceIdOrRef: string, options: TraceLookupOptions) => {
      const result = await runTraceLogs(traceIdOrRef, options);

      if (!result.ok) {
        writeFailure(result, options.json === true);
        process.exitCode = 1;
      }
    });
}

async function runTraceInspect(
  traceIdOrRef: string,
  options: TraceLookupOptions,
): Promise<{ ok: true } | TraceFailure> {
  try {
    const resolved = await resolveTraceIdOrRef(traceIdOrRef);

    if (!resolved.ok) {
      return missingRefFailure("inspect", resolved.ref);
    }

    const config = loadConfig();
    const client = new SigNozClient(config);
    const response = await client.postJson(
      queryRangeEndpoint,
      buildTraceInspectQueryRange({
        traceId: resolved.traceId,
        since: options.since,
        limit: options.limit,
      }),
    );

    if (!response.ok) {
      return signozFailure("inspect", response);
    }

    const parsed = parseRawTraceRows(response.bodyJson);

    if (!parsed.ok) {
      return unexpectedResponseFailure("inspect", parsed.message, response);
    }

    if (options.json === true) {
      process.stdout.write(
        formatTraceInspectJson(parsed.rows, {
          traceIdOrRef,
          traceId: resolved.traceId,
          since: options.since,
          limit: options.limit,
        }),
      );
      return { ok: true };
    }

    process.stdout.write(formatTraceInspectText(resolved.traceId, parsed.rows));

    return { ok: true };
  } catch (error) {
    return failureFromError("inspect", error);
  }
}

async function runTraceLogs(
  traceIdOrRef: string,
  options: TraceLookupOptions,
): Promise<{ ok: true } | TraceFailure> {
  try {
    const resolved = await resolveTraceIdOrRef(traceIdOrRef);

    if (!resolved.ok) {
      return missingRefFailure("logs", resolved.ref);
    }

    const config = loadConfig();
    const client = new SigNozClient(config);
    const response = await client.postJson(
      queryRangeEndpoint,
      buildTraceLogsQueryRange({
        traceId: resolved.traceId,
        since: options.since,
        limit: options.limit,
      }),
    );

    if (!response.ok) {
      return signozFailure("logs", response);
    }

    const parsed = parseRawLogRows(response.bodyJson);

    if (!parsed.ok) {
      return unexpectedResponseFailure("logs", parsed.message, response);
    }

    if (options.json === true) {
      process.stdout.write(
        formatTraceLogsJson(parsed.rows, {
          traceIdOrRef,
          traceId: resolved.traceId,
          since: options.since,
          limit: options.limit,
        }),
      );
      return { ok: true };
    }

    process.stdout.write(formatTraceLogsText(resolved.traceId, parsed.rows));

    return { ok: true };
  } catch (error) {
    return failureFromError("logs", error);
  }
}

function parseLimit(value: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("Limit must be a positive integer");
  }

  return parsed;
}

function missingRefFailure(
  command: TraceFailure["command"],
  ref: string,
): TraceFailure {
  return {
    ok: false,
    command,
    code: "missing_ref",
    message: `${ref} is not in .signoz-agent/session.json; rerun signoz-agent traces search or pass a full trace ID`,
    ref,
  };
}

function signozFailure(
  command: TraceFailure["command"],
  response: SigNozResponse,
): TraceFailure {
  return {
    ok: false,
    command,
    code: "signoz_error",
    message: `SigNoz trace ${command} failed`,
    endpoint: queryRangeEndpoint,
    httpStatus: response.status,
  };
}

function unexpectedResponseFailure(
  command: TraceFailure["command"],
  message: string,
  response: SigNozResponse,
): TraceFailure {
  return {
    ok: false,
    command,
    code: "unexpected_response",
    message,
    endpoint: queryRangeEndpoint,
    httpStatus: response.status,
  };
}

function failureFromError(
  command: TraceFailure["command"],
  error: unknown,
): TraceFailure {
  if (error instanceof ConfigError) {
    return {
      ok: false,
      command,
      code: error.code,
      message: error.message,
      missingVariables: error.missingVariables,
    };
  }

  if (error instanceof SigNozNetworkError) {
    return {
      ok: false,
      command,
      code: "unreachable",
      message: error.message,
      endpoint: queryRangeEndpoint,
    };
  }

  if (error instanceof Error) {
    return {
      ok: false,
      command,
      code: "unexpected_response",
      message: error.message,
      endpoint: queryRangeEndpoint,
    };
  }

  return {
    ok: false,
    command,
    code: "unexpected_response",
    message: `Unable to run trace ${command}`,
    endpoint: queryRangeEndpoint,
  };
}

function writeFailure(result: TraceFailure, json: boolean): void {
  if (json) {
    process.stderr.write(`${JSON.stringify(result)}\n`);
    return;
  }

  process.stderr.write(`${formatFailure(result)}\n`);
}

function formatFailure(result: TraceFailure): string {
  switch (result.code) {
    case "missing_ref":
      return `error trace ref ${result.ref ?? "unknown"} not found; rerun signoz-agent traces search or pass a full trace ID`;
    case "missing_config":
      return `error missing ${formatMissingVariables(result.missingVariables)}`;
    case "invalid_config":
      return `error invalid config: ${result.message}`;
    case "unreachable":
      return "error signoz unreachable";
    case "signoz_error":
      return `error signoz trace ${result.command} failed status=${result.httpStatus}`;
    case "unexpected_response":
      return `error signoz trace ${result.command} unexpected response: ${result.message}`;
    default: {
      const exhaustiveCheck: never = result.code;
      return exhaustiveCheck;
    }
  }
}

function formatMissingVariables(
  missingVariables: string[] | undefined,
): string {
  if (missingVariables === undefined || missingVariables.length === 0) {
    return "required config";
  }

  return missingVariables.join(",");
}

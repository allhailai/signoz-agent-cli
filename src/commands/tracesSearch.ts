import { Command, InvalidArgumentError } from "commander";

import { ConfigError, loadConfig } from "../config.js";
import { formatTraceSearchJson } from "../output/json.js";
import { formatTraceSearchText } from "../output/text.js";
import { writeTraceRefs } from "../session/refStore.js";
import {
  SigNozClient,
  SigNozNetworkError,
  type SigNozResponse,
} from "../signoz/client.js";
import {
  buildFailedTracesSearchQueryRange,
  queryRangeEndpoint,
} from "../signoz/queryRange.js";
import { parseRawTraceRows } from "../signoz/traceRows.js";

type TracesSearchOptions = {
  service: string;
  route?: string;
  status: string;
  minDuration?: number;
  since: string;
  limit: number;
  json?: boolean;
};

type TraceSearchFailure = {
  ok: false;
  code:
    | "missing_config"
    | "invalid_config"
    | "unreachable"
    | "signoz_error"
    | "unexpected_response";
  message: string;
  endpoint?: string;
  httpStatus?: number;
  missingVariables?: string[];
};

const defaultSince = "30m";
const defaultStatusExpression = ">=400";
const defaultLimit = 20;

export function registerTracesSearchCommand(program: Command): void {
  const traces = program.command("traces").description("Search SigNoz traces.");

  traces
    .command("search")
    .description("Search failing traces and assign session-local refs.")
    .requiredOption("--service <name>", "Service name to search.")
    .option("--route <route>", "HTTP route to match.")
    .option(
      "--status <expr>",
      "HTTP status expression to match.",
      defaultStatusExpression,
    )
    .option("--min-duration <ms>", "Minimum duration in milliseconds.", parseMs)
    .option("--since <duration>", "Relative time window.", defaultSince)
    .option("--limit <n>", "Maximum rows to return.", parseLimit, defaultLimit)
    .option("--json", "Print structured JSON output.")
    .action(async (options: TracesSearchOptions) => {
      const result = await runTracesSearch(options);

      if (!result.ok) {
        writeFailure(result, options.json === true);
        process.exitCode = 1;
      }
    });
}

async function runTracesSearch(
  options: TracesSearchOptions,
): Promise<{ ok: true } | TraceSearchFailure> {
  try {
    const config = loadConfig();
    const client = new SigNozClient(config);
    const response = await client.postJson(
      queryRangeEndpoint,
      buildFailedTracesSearchQueryRange(traceSearchQueryOptions(options)),
    );

    if (!response.ok) {
      return signozFailure(response);
    }

    const parsed = parseRawTraceRows(response.bodyJson);

    if (!parsed.ok) {
      return {
        ok: false,
        code: "unexpected_response",
        message: parsed.message,
        endpoint: queryRangeEndpoint,
        httpStatus: response.status,
      };
    }

    const refs = await writeTraceRefs(parsed.rows);
    const jsonOptions = traceSearchJsonOptions(options);

    if (options.json === true) {
      process.stdout.write(
        formatTraceSearchJson(parsed.rows, refs, jsonOptions),
      );
      return { ok: true };
    }

    process.stdout.write(
      formatTraceSearchText(refs, traceSearchTextOptions(options)),
    );

    return { ok: true };
  } catch (error) {
    return traceSearchFailureFromError(error);
  }
}

function parseMs(value: string): number {
  return parsePositiveInteger(value, "Minimum duration");
}

function parseLimit(value: string): number {
  return parsePositiveInteger(value, "Limit");
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError(`${label} must be a positive integer`);
  }

  return parsed;
}

function signozFailure(response: SigNozResponse): TraceSearchFailure {
  return {
    ok: false,
    code: "signoz_error",
    message: "SigNoz trace search failed",
    endpoint: queryRangeEndpoint,
    httpStatus: response.status,
  };
}

function traceSearchFailureFromError(error: unknown): TraceSearchFailure {
  if (error instanceof ConfigError) {
    return {
      ok: false,
      code: error.code,
      message: error.message,
      missingVariables: error.missingVariables,
    };
  }

  if (error instanceof SigNozNetworkError) {
    return {
      ok: false,
      code: "unreachable",
      message: error.message,
      endpoint: queryRangeEndpoint,
    };
  }

  if (error instanceof Error) {
    return {
      ok: false,
      code: "unexpected_response",
      message: error.message,
      endpoint: queryRangeEndpoint,
    };
  }

  return {
    ok: false,
    code: "unexpected_response",
    message: "Unable to search SigNoz traces",
    endpoint: queryRangeEndpoint,
  };
}

function writeFailure(result: TraceSearchFailure, json: boolean): void {
  if (json) {
    process.stderr.write(`${JSON.stringify(result)}\n`);
    return;
  }

  process.stderr.write(`${formatFailure(result)}\n`);
}

function formatFailure(result: TraceSearchFailure): string {
  switch (result.code) {
    case "missing_config":
      return `error missing ${formatMissingVariables(result.missingVariables)}`;
    case "invalid_config":
      return `error invalid config: ${result.message}`;
    case "unreachable":
      return "error signoz unreachable";
    case "signoz_error":
      return `error signoz trace search failed status=${result.httpStatus}`;
    case "unexpected_response":
      return `error signoz trace search unexpected response: ${result.message}`;
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

function traceSearchJsonOptions(options: TracesSearchOptions): {
  serviceName: string;
  route?: string;
  statusExpression: string;
  minDurationMs?: number;
  since: string;
  limit: number;
} {
  const jsonOptions = {
    serviceName: options.service,
    statusExpression: options.status,
    since: options.since,
    limit: options.limit,
  };

  return {
    ...jsonOptions,
    ...(options.route === undefined ? {} : { route: options.route }),
    ...(options.minDuration === undefined
      ? {}
      : { minDurationMs: options.minDuration }),
  };
}

function traceSearchQueryOptions(options: TracesSearchOptions): {
  serviceName: string;
  route?: string;
  statusExpression: string;
  minDurationMs?: number;
  since: string;
  limit: number;
} {
  return traceSearchJsonOptions(options);
}

function traceSearchTextOptions(options: TracesSearchOptions): {
  serviceName: string;
  route?: string;
  since: string;
  jsonCommand: string;
} {
  return {
    serviceName: options.service,
    since: options.since,
    jsonCommand: buildJsonCommand(options),
    ...(options.route === undefined ? {} : { route: options.route }),
  };
}

function buildJsonCommand(options: TracesSearchOptions): string {
  const args = [
    "signoz-agent",
    "traces",
    "search",
    "--service",
    shellToken(options.service),
  ];

  if (options.route !== undefined) {
    args.push("--route", shellToken(options.route));
  }

  args.push("--status", shellToken(options.status));

  if (options.minDuration !== undefined) {
    args.push("--min-duration", options.minDuration.toString());
  }

  args.push("--since", shellToken(options.since));
  args.push("--limit", options.limit.toString());
  args.push("--json");

  return args.join(" ");
}

function shellToken(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}

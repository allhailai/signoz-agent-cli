import { Command, InvalidArgumentError } from "commander";

import { ConfigError, loadConfig } from "../config.js";
import { formatTraceSearchJson } from "../output/json.js";
import { formatRawQueryRangeDiagnostic } from "../output/raw.js";
import { formatTraceSearchText } from "../output/text.js";
import { readSelectedService, writeTraceRefs } from "../session/refStore.js";
import {
  SigNozClient,
  SigNozNetworkError,
  type SigNozResponse,
} from "../signoz/client.js";
import {
  buildTracesSearchQueryRange,
  queryRangeEndpoint,
} from "../signoz/queryRange.js";
import { parseRawTraceRows } from "../signoz/traceRows.js";

type TracesSearchOptions = {
  filter?: string;
  service?: string;
  route?: string;
  status?: string;
  minDuration?: number;
  since: string;
  limit: number;
  json?: boolean;
  raw?: boolean;
};

type ResolvedTraceSearchOptions = {
  filterExpression?: string;
  serviceName?: string;
  route?: string;
  statusExpression?: string;
  minDurationMs?: number;
  since: string;
  limit: number;
};

type TraceSearchFailure = {
  ok: false;
  code:
    | "missing_selection"
    | "invalid_options"
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
const defaultLimit = 20;

export function registerTracesSearchCommand(program: Command): void {
  const traces = program.command("traces").description("Search SigNoz traces.");

  traces
    .command("search")
    .description("Search traces and assign session-local refs.")
    .option("--filter <expr>", "Direct SigNoz trace filter expression.")
    .option("--service <name>", "Service name to search.")
    .option("--route <route>", "HTTP route to match.")
    .option("--status <expr>", "HTTP status expression to match.")
    .option("--min-duration <ms>", "Minimum duration in milliseconds.", parseMs)
    .option("--since <duration>", "Relative time window.", defaultSince)
    .option("--limit <n>", "Maximum rows to return.", parseLimit, defaultLimit)
    .option("--json", "Print structured JSON output.")
    .option("--raw", "Print raw query_range diagnostics.")
    .action(async (options: TracesSearchOptions) => {
      const result = await runTracesSearch(options);

      if (!result.ok) {
        writeFailure(result, options.json === true && options.raw !== true);
        process.exitCode = 1;
      }
    });
}

async function runTracesSearch(
  options: TracesSearchOptions,
): Promise<{ ok: true } | TraceSearchFailure> {
  try {
    if (options.json === true && options.raw === true) {
      return {
        ok: false,
        code: "invalid_options",
        message: "Cannot combine --json and --raw",
      };
    }

    const resolvedOptions = await resolveTraceSearchOptions(options);

    if (!resolvedOptions.ok) {
      return resolvedOptions;
    }

    const config = loadConfig();
    const client = new SigNozClient(config);
    const requestPayload = buildTracesSearchQueryRange(resolvedOptions.options);
    const response = await client.postJson(queryRangeEndpoint, requestPayload);

    if (options.raw === true) {
      process.stdout.write(
        formatRawQueryRangeDiagnostic({
          command: "traces search",
          endpoint: queryRangeEndpoint,
          request: requestPayload,
          response,
        }),
      );
      return { ok: true };
    }

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

    if (options.json === true) {
      process.stdout.write(
        formatTraceSearchJson(parsed.rows, refs, resolvedOptions.options),
      );
      return { ok: true };
    }

    process.stdout.write(
      formatTraceSearchText(
        refs,
        traceSearchTextOptions(resolvedOptions.options),
      ),
    );

    return { ok: true };
  } catch (error) {
    return traceSearchFailureFromError(error);
  }
}

async function resolveTraceSearchOptions(
  options: TracesSearchOptions,
): Promise<
  { ok: true; options: ResolvedTraceSearchOptions } | TraceSearchFailure
> {
  if (options.filter !== undefined && hasStructuredTraceFilters(options)) {
    return {
      ok: false,
      code: "invalid_options",
      message:
        "Cannot combine --filter with --service, --route, --status, or --min-duration",
    };
  }

  if (options.filter !== undefined) {
    return {
      ok: true,
      options: {
        filterExpression: options.filter,
        since: options.since,
        limit: options.limit,
      },
    };
  }

  const serviceName = options.service ?? (await readSelectedService());

  if (serviceName === undefined) {
    return {
      ok: false,
      code: "missing_selection",
      message: "No service selected",
    };
  }

  return {
    ok: true,
    options: {
      serviceName,
      since: options.since,
      limit: options.limit,
      ...(options.route === undefined ? {} : { route: options.route }),
      ...(options.status === undefined
        ? {}
        : { statusExpression: options.status }),
      ...(options.minDuration === undefined
        ? {}
        : { minDurationMs: options.minDuration }),
    },
  };
}

function hasStructuredTraceFilters(options: TracesSearchOptions): boolean {
  return (
    options.service !== undefined ||
    options.route !== undefined ||
    options.status !== undefined ||
    options.minDuration !== undefined
  );
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
    case "missing_selection":
      return [
        "error no service selected",
        "Next:",
        "- signoz-agent services list --since 2h",
        "- signoz-agent services select <service-name>",
        "- signoz-agent traces search --service <service-name>",
        '- signoz-agent traces search --filter "<expr>"',
      ].join("\n");
    case "invalid_options":
      return `error ${result.message}`;
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

function traceSearchTextOptions(options: ResolvedTraceSearchOptions): {
  serviceName?: string;
  filterExpression?: string;
  route?: string;
  since: string;
  jsonCommand: string;
} {
  return {
    since: options.since,
    jsonCommand: buildJsonCommand(options),
    ...(options.filterExpression === undefined
      ? {}
      : { filterExpression: options.filterExpression }),
    ...(options.serviceName === undefined
      ? {}
      : { serviceName: options.serviceName }),
    ...(options.route === undefined ? {} : { route: options.route }),
  };
}

function buildJsonCommand(options: ResolvedTraceSearchOptions): string {
  const args = ["signoz-agent", "traces", "search"];

  if (options.filterExpression !== undefined) {
    args.push("--filter", shellToken(options.filterExpression));
  }

  if (options.serviceName !== undefined) {
    args.push("--service", shellToken(options.serviceName));
  }

  if (options.route !== undefined) {
    args.push("--route", shellToken(options.route));
  }

  if (options.statusExpression !== undefined) {
    args.push("--status", shellToken(options.statusExpression));
  }

  if (options.minDurationMs !== undefined) {
    args.push("--min-duration", options.minDurationMs.toString());
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

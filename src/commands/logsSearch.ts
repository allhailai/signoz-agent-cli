import { Command, InvalidArgumentError } from "commander";

import { ConfigError, loadConfig } from "../config.js";
import { formatLogsSearchJson } from "../output/json.js";
import { formatRawQueryRangeDiagnostic } from "../output/raw.js";
import { formatLogsSearchText } from "../output/text.js";
import { readSelectedService, writeLogRefs } from "../session/refStore.js";
import {
  SigNozClient,
  SigNozNetworkError,
  type SigNozResponse,
} from "../signoz/client.js";
import {
  buildLogsSearchQueryRange,
  queryRangeEndpoint,
} from "../signoz/queryRange.js";
import { parseRawLogRows } from "../signoz/logRows.js";

type LogsSearchOptions = {
  filter?: string;
  contains?: string;
  traceId?: string;
  since: string;
  limit: number;
  json?: boolean;
  raw?: boolean;
};

type ResolvedLogsSearchOptions = {
  filterExpression?: string;
  serviceName?: string;
  contains?: string;
  traceId?: string;
  since: string;
  limit: number;
};

type LogsSearchFailure = {
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

export function registerLogsSearchCommand(program: Command): void {
  const logs = program.command("logs").description("Search SigNoz logs.");

  logs
    .command("search")
    .description("Search logs and assign session-local refs.")
    .option("--filter <expr>", "Direct SigNoz log filter expression.")
    .option("--contains <text>", "Text to search for in log body/message.")
    .option("--trace-id <id>", "Trace ID to search correlated logs for.")
    .option("--since <duration>", "Relative time window.", defaultSince)
    .option("--limit <n>", "Maximum rows to return.", parseLimit, defaultLimit)
    .option("--json", "Print structured JSON output.")
    .option("--raw", "Print raw query_range diagnostics.")
    .action(async (options: LogsSearchOptions) => {
      const result = await runLogsSearch(options);

      if (!result.ok) {
        writeFailure(result, options.json === true && options.raw !== true);
        process.exitCode = 1;
      }
    });
}

async function runLogsSearch(
  options: LogsSearchOptions,
): Promise<{ ok: true } | LogsSearchFailure> {
  try {
    if (options.json === true && options.raw === true) {
      return {
        ok: false,
        code: "invalid_options",
        message: "Cannot combine --json and --raw",
      };
    }

    const resolvedOptions = await resolveLogsSearchOptions(options);

    if (!resolvedOptions.ok) {
      return resolvedOptions;
    }

    const config = loadConfig();
    const client = new SigNozClient(config);
    const requestPayload = buildLogsSearchQueryRange(resolvedOptions.options);
    const response = await client.postJson(queryRangeEndpoint, requestPayload);

    if (options.raw === true) {
      process.stdout.write(
        formatRawQueryRangeDiagnostic({
          command: "logs search",
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

    const parsed = parseRawLogRows(response.bodyJson);

    if (!parsed.ok) {
      return {
        ok: false,
        code: "unexpected_response",
        message: parsed.message,
        endpoint: queryRangeEndpoint,
        httpStatus: response.status,
      };
    }

    const refs = await writeLogRefs(parsed.rows);

    if (options.json === true) {
      process.stdout.write(
        formatLogsSearchJson(parsed.rows, refs, resolvedOptions.options),
      );
      return { ok: true };
    }

    process.stdout.write(
      formatLogsSearchText(
        refs,
        logsSearchTextOptions(resolvedOptions.options),
      ),
    );

    return { ok: true };
  } catch (error) {
    return logsSearchFailureFromError(error);
  }
}

async function resolveLogsSearchOptions(
  options: LogsSearchOptions,
): Promise<
  { ok: true; options: ResolvedLogsSearchOptions } | LogsSearchFailure
> {
  if (countExplicitSelectors(options) > 1) {
    return {
      ok: false,
      code: "invalid_options",
      message: "Cannot combine --filter, --contains, or --trace-id",
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

  if (options.contains !== undefined) {
    return {
      ok: true,
      options: {
        contains: options.contains,
        since: options.since,
        limit: options.limit,
      },
    };
  }

  if (options.traceId !== undefined) {
    return {
      ok: true,
      options: {
        traceId: options.traceId,
        since: options.since,
        limit: options.limit,
      },
    };
  }

  const serviceName = await readSelectedService();

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
    },
  };
}

function countExplicitSelectors(options: LogsSearchOptions): number {
  return [
    options.filter !== undefined,
    options.contains !== undefined,
    options.traceId !== undefined,
  ].filter(Boolean).length;
}

function parseLimit(value: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("Limit must be a positive integer");
  }

  return parsed;
}

function signozFailure(response: SigNozResponse): LogsSearchFailure {
  return {
    ok: false,
    code: "signoz_error",
    message: "SigNoz logs search failed",
    endpoint: queryRangeEndpoint,
    httpStatus: response.status,
  };
}

function logsSearchFailureFromError(error: unknown): LogsSearchFailure {
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
    message: "Unable to search SigNoz logs",
    endpoint: queryRangeEndpoint,
  };
}

function writeFailure(result: LogsSearchFailure, json: boolean): void {
  if (json) {
    process.stderr.write(`${JSON.stringify(result)}\n`);
    return;
  }

  process.stderr.write(`${formatFailure(result)}\n`);
}

function formatFailure(result: LogsSearchFailure): string {
  switch (result.code) {
    case "missing_selection":
      return [
        "error no service selected",
        "Next:",
        "- signoz-agent services list --since 2h",
        "- signoz-agent services select <service-name>",
        '- signoz-agent logs search --filter "<expr>"',
        '- signoz-agent logs search --contains "<text>"',
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
      return `error signoz logs search failed status=${result.httpStatus}`;
    case "unexpected_response":
      return `error signoz logs search unexpected response: ${result.message}`;
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

function logsSearchTextOptions(options: ResolvedLogsSearchOptions): {
  filterExpression?: string;
  serviceName?: string;
  contains?: string;
  traceId?: string;
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
    ...(options.contains === undefined ? {} : { contains: options.contains }),
    ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
  };
}

function buildJsonCommand(options: ResolvedLogsSearchOptions): string {
  const args = ["signoz-agent", "logs", "search"];

  if (options.filterExpression !== undefined) {
    args.push("--filter", shellToken(options.filterExpression));
  }

  if (options.contains !== undefined) {
    args.push("--contains", shellToken(options.contains));
  }

  if (options.traceId !== undefined) {
    args.push("--trace-id", shellToken(options.traceId));
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

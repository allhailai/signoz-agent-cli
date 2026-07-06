import { Command, InvalidArgumentError } from "commander";

import { ConfigError, loadConfig } from "../config.js";
import { formatServicesListJson } from "../output/json.js";
import { formatRawQueryRangeDiagnostic } from "../output/raw.js";
import {
  formatSelectedServiceText,
  formatServicesListText,
} from "../output/text.js";
import {
  readSelectedService,
  writeSelectedService,
} from "../session/refStore.js";
import {
  SigNozClient,
  SigNozNetworkError,
  type SigNozResponse,
} from "../signoz/client.js";
import {
  buildServicesListQueryRange,
  queryRangeEndpoint,
} from "../signoz/queryRange.js";
import { summarizeServicesFromTraceRows } from "../signoz/serviceRows.js";
import { parseRawTraceRows } from "../signoz/traceRows.js";

type ServicesListOptions = {
  since: string;
  limit: number;
  json?: boolean;
  raw?: boolean;
};

type ServicesFailure = {
  ok: false;
  command: "list" | "current";
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

const defaultSince = "2h";
const defaultLimit = 20;
const rawRowsPerService = 20;

export function registerServicesCommand(program: Command): void {
  const services = program
    .command("services")
    .description("Discover and select SigNoz services.");

  services
    .command("list")
    .description("List services seen in recent trace data.")
    .option("--since <duration>", "Relative time window.", defaultSince)
    .option(
      "--limit <n>",
      "Maximum services to print.",
      parseLimit,
      defaultLimit,
    )
    .option("--json", "Print structured JSON output.")
    .option("--raw", "Print raw query_range diagnostics.")
    .action(async (options: ServicesListOptions) => {
      const result = await runServicesList(options);

      if (!result.ok) {
        writeFailure(result, options.json === true && options.raw !== true);
        process.exitCode = 1;
      }
    });

  services
    .command("select")
    .description("Store the selected service by full service name.")
    .argument("<service-name>", "Full service name.")
    .action(async (serviceName: string) => {
      await writeSelectedService(serviceName);
      process.stdout.write(formatSelectedServiceText(serviceName));
    });

  services
    .command("current")
    .description("Print the selected service.")
    .action(async () => {
      const result = await runServicesCurrent();

      if (!result.ok) {
        writeFailure(result, false);
        process.exitCode = 1;
      }
    });
}

async function runServicesList(
  options: ServicesListOptions,
): Promise<{ ok: true } | ServicesFailure> {
  try {
    if (options.json === true && options.raw === true) {
      return invalidOptionsFailure("list", "Cannot combine --json and --raw");
    }

    const config = loadConfig();
    const client = new SigNozClient(config);
    const requestPayload = buildServicesListQueryRange({
      since: options.since,
      limit: rawTraceLimit(options.limit),
    });
    const response = await client.postJson(queryRangeEndpoint, requestPayload);

    if (options.raw === true) {
      process.stdout.write(
        formatRawQueryRangeDiagnostic({
          command: "services list",
          endpoint: queryRangeEndpoint,
          request: requestPayload,
          response,
        }),
      );
      return { ok: true };
    }

    if (!response.ok) {
      return signozFailure("list", response);
    }

    const parsed = parseRawTraceRows(response.bodyJson);

    if (!parsed.ok) {
      return unexpectedResponseFailure("list", parsed.message, response);
    }

    const services = summarizeServicesFromTraceRows(parsed.rows, options.limit);

    if (options.json === true) {
      process.stdout.write(
        formatServicesListJson(services, {
          since: options.since,
          limit: options.limit,
        }),
      );
      return { ok: true };
    }

    process.stdout.write(
      formatServicesListText(services, { since: options.since }),
    );

    return { ok: true };
  } catch (error) {
    return failureFromError("list", error);
  }
}

async function runServicesCurrent(): Promise<{ ok: true } | ServicesFailure> {
  const serviceName = await readSelectedService();

  if (serviceName === undefined) {
    return {
      ok: false,
      command: "current",
      code: "missing_selection",
      message:
        "No service selected; run signoz-agent services select <service-name>",
    };
  }

  process.stdout.write(formatSelectedServiceText(serviceName));

  return { ok: true };
}

function parseLimit(value: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("Limit must be a positive integer");
  }

  return parsed;
}

function rawTraceLimit(serviceLimit: number): number {
  return serviceLimit * rawRowsPerService;
}

function invalidOptionsFailure(
  command: ServicesFailure["command"],
  message: string,
): ServicesFailure {
  return {
    ok: false,
    command,
    code: "invalid_options",
    message,
  };
}

function signozFailure(
  command: ServicesFailure["command"],
  response: SigNozResponse,
): ServicesFailure {
  return {
    ok: false,
    command,
    code: "signoz_error",
    message: `SigNoz services ${command} failed`,
    endpoint: queryRangeEndpoint,
    httpStatus: response.status,
  };
}

function unexpectedResponseFailure(
  command: ServicesFailure["command"],
  message: string,
  response: SigNozResponse,
): ServicesFailure {
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
  command: ServicesFailure["command"],
  error: unknown,
): ServicesFailure {
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
    message: `Unable to run services ${command}`,
    endpoint: queryRangeEndpoint,
  };
}

function writeFailure(result: ServicesFailure, json: boolean): void {
  if (json) {
    process.stderr.write(`${JSON.stringify(result)}\n`);
    return;
  }

  process.stderr.write(`${formatFailure(result)}\n`);
}

function formatFailure(result: ServicesFailure): string {
  switch (result.code) {
    case "missing_selection":
      return "error no selected service; run signoz-agent services select <service-name>";
    case "invalid_options":
      return `error ${result.message}`;
    case "missing_config":
      return `error missing ${formatMissingVariables(result.missingVariables)}`;
    case "invalid_config":
      return `error invalid config: ${result.message}`;
    case "unreachable":
      return "error signoz unreachable";
    case "signoz_error":
      return `error signoz services ${result.command} failed status=${result.httpStatus}`;
    case "unexpected_response":
      return `error signoz services ${result.command} unexpected response: ${result.message}`;
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

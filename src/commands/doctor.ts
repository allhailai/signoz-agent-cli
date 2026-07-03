import { Command } from "commander";

import { ConfigError, loadConfig } from "../config.js";
import {
  SigNozClient,
  SigNozNetworkError,
  type SigNozResponse,
} from "../signoz/client.js";

const queryRangePath = "/api/v5/query_range";
const validationPayload = {};

type DoctorJsonOption = {
  json?: boolean;
};

type DoctorSuccess = {
  ok: true;
  status: "authenticated";
  apiUrl: string;
  endpoint: string;
  httpStatus: number;
};

type DoctorFailure = {
  ok: false;
  code:
    | "missing_config"
    | "invalid_config"
    | "unauthenticated"
    | "unreachable"
    | "unexpected_response";
  message: string;
  endpoint?: string;
  httpStatus?: number;
  missingVariables?: string[];
};

type DoctorResult = DoctorSuccess | DoctorFailure;

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Verify SigNoz config, auth, and API reachability.")
    .option("--json", "Print structured JSON output.")
    .action(async (options: DoctorJsonOption) => {
      const result = await runDoctor();

      writeDoctorResult(result, options.json === true);

      if (!result.ok) {
        process.exitCode = 1;
      }
    });
}

export async function runDoctor(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: ConstructorParameters<typeof SigNozClient>[1] = globalThis.fetch,
): Promise<DoctorResult> {
  try {
    const config = loadConfig(env);
    const client = new SigNozClient(config, fetchImpl);
    const response = await client.postJson(queryRangePath, validationPayload);

    return interpretDoctorResponse(config.apiUrl, response);
  } catch (error) {
    return doctorFailureFromError(error);
  }
}

function interpretDoctorResponse(
  apiUrl: string,
  response: SigNozResponse,
): DoctorResult {
  if (response.ok || isAuthenticatedInvalidInput(response)) {
    return {
      ok: true,
      status: "authenticated",
      apiUrl,
      endpoint: queryRangePath,
      httpStatus: response.status,
    };
  }

  if (response.status === 401) {
    return {
      ok: false,
      code: "unauthenticated",
      message: "SigNoz authentication failed",
      endpoint: queryRangePath,
      httpStatus: response.status,
    };
  }

  return {
    ok: false,
    code: "unexpected_response",
    message: "SigNoz API returned an unexpected validation response",
    endpoint: queryRangePath,
    httpStatus: response.status,
  };
}

function isAuthenticatedInvalidInput(response: SigNozResponse): boolean {
  if (response.status !== 400) {
    return false;
  }

  const searchableBody =
    response.bodyJson === undefined
      ? response.bodyText
      : JSON.stringify(response.bodyJson);

  return searchableBody.toLowerCase().includes("invalid_input");
}

function doctorFailureFromError(error: unknown): DoctorFailure {
  if (error instanceof ConfigError) {
    const failure: DoctorFailure = {
      ok: false,
      code: error.code,
      message: error.message,
    };

    if (error.missingVariables.length > 0) {
      failure.missingVariables = error.missingVariables;
    }

    return failure;
  }

  if (error instanceof SigNozNetworkError) {
    return {
      ok: false,
      code: "unreachable",
      message: error.message,
      endpoint: queryRangePath,
    };
  }

  return {
    ok: false,
    code: "unexpected_response",
    message: "Unable to validate SigNoz configuration",
    endpoint: queryRangePath,
  };
}

function writeDoctorResult(result: DoctorResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  const line = formatDoctorResult(result);

  if (result.ok) {
    process.stdout.write(`${line}\n`);
    return;
  }

  process.stderr.write(`${line}\n`);
}

function formatDoctorResult(result: DoctorResult): string {
  if (result.ok) {
    return `ok signoz reachable authenticated status=${result.httpStatus}`;
  }

  switch (result.code) {
    case "missing_config":
      return `error missing ${formatMissingVariables(result.missingVariables)}`;
    case "invalid_config":
      return `error invalid config: ${result.message}`;
    case "unauthenticated":
      return `error signoz unauthenticated status=${result.httpStatus}`;
    case "unreachable":
      return "error signoz unreachable";
    case "unexpected_response":
      return formatUnexpectedResponse(result);
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

function formatUnexpectedResponse(result: DoctorFailure): string {
  if (result.httpStatus === undefined) {
    return "error signoz validation failed";
  }

  return `error signoz validation failed status=${result.httpStatus}`;
}

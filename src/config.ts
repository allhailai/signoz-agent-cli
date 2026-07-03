export interface SigNozConfig {
  apiUrl: string;
  apiKey: string;
}

export type ConfigErrorCode = "missing_config" | "invalid_config";

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly missingVariables: string[];

  constructor(
    code: ConfigErrorCode,
    message: string,
    missingVariables: string[] = [],
  ) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.missingVariables = missingVariables;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SigNozConfig {
  const apiUrl = env.SIGNOZ_API_URL?.trim();
  const apiKey = env.SIGNOZ_API_KEY?.trim();

  if (
    apiUrl === undefined ||
    apiUrl === "" ||
    apiKey === undefined ||
    apiKey === ""
  ) {
    const missingVariables: string[] = [];

    if (apiUrl === undefined || apiUrl === "") {
      missingVariables.push("SIGNOZ_API_URL");
    }

    if (apiKey === undefined || apiKey === "") {
      missingVariables.push("SIGNOZ_API_KEY");
    }

    throw new ConfigError(
      "missing_config",
      `Missing required environment variables: ${missingVariables.join(", ")}`,
      missingVariables,
    );
  }

  const normalizedUrl = normalizeApiUrl(apiUrl);

  return {
    apiUrl: normalizedUrl,
    apiKey,
  };
}

function normalizeApiUrl(apiUrl: string): string {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(apiUrl);
  } catch {
    throw new ConfigError(
      "invalid_config",
      "SIGNOZ_API_URL must be a valid HTTP(S) URL",
    );
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new ConfigError(
      "invalid_config",
      "SIGNOZ_API_URL must use http or https",
    );
  }

  return parsedUrl.toString().replace(/\/$/, "");
}

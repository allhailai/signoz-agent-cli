import type { SigNozConfig } from "../config.js";

export interface SigNozResponse {
  status: number;
  ok: boolean;
  bodyText: string;
  bodyJson: unknown;
}

export class SigNozNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigNozNetworkError";
  }
}

type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

export class SigNozClient {
  private readonly config: SigNozConfig;
  private readonly fetchImpl: FetchLike;

  constructor(config: SigNozConfig, fetchImpl: FetchLike = globalThis.fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async postJson(path: string, body: unknown): Promise<SigNozResponse> {
    return this.requestJson("POST", path, body);
  }

  async getJson(path: string): Promise<SigNozResponse> {
    return this.requestJson("GET", path);
  }

  async getPublicJson(path: string): Promise<SigNozResponse> {
    return this.requestJson("GET", path, undefined, false);
  }

  async patchJson(path: string, body: unknown): Promise<SigNozResponse> {
    return this.requestJson("PATCH", path, body);
  }

  private async requestJson(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
    authenticated = true,
  ): Promise<SigNozResponse> {
    const url = this.buildUrl(path);
    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          "content-type": "application/json",
          ...(authenticated ? { "SIGNOZ-API-KEY": this.config.apiKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new SigNozNetworkError("Unable to reach SigNoz API");
    }

    return readResponse(response);
  }

  private buildUrl(path: string): URL {
    const relativePath = path.startsWith("/") ? path.slice(1) : path;

    return new URL(`${this.config.apiUrl}/${relativePath}`);
  }
}

async function readResponse(response: Response): Promise<SigNozResponse> {
  const bodyText = await response.text();

  return {
    status: response.status,
    ok: response.ok,
    bodyText,
    bodyJson: parseJson(bodyText),
  };
}

function parseJson(bodyText: string): unknown {
  if (bodyText === "") {
    return undefined;
  }

  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return undefined;
  }
}

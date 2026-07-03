import { execFile } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type CapturedRequest = {
  method: string | undefined;
  url: string | undefined;
  apiKey: string | string[] | undefined;
  body: string;
};

describe("doctor command", () => {
  it("fails clearly when required config is missing", async () => {
    const env = cliEnv();

    delete env.SIGNOZ_API_URL;
    delete env.SIGNOZ_API_KEY;

    const result = await runCli(["doctor"], env);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("error missing SIGNOZ_API_URL,SIGNOZ_API_KEY\n");
  });

  it("prints compact success when SigNoz returns authenticated invalid input", async () => {
    await withFakeSigNoz(
      400,
      { error: "invalid_input", message: "invalid input" },
      async ({ requests, url }) => {
        const result = await runCli(
          ["doctor"],
          cliEnv({
            SIGNOZ_API_URL: url,
            SIGNOZ_API_KEY: "test-secret",
          }),
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(
          "ok signoz reachable authenticated status=400\n",
        );
        expect(result.stderr).toBe("");
        expect(result.stdout).not.toContain("test-secret");
        expect(result.stderr).not.toContain("test-secret");
        expect(requests).toEqual([
          {
            method: "POST",
            url: "/api/v5/query_range",
            apiKey: "test-secret",
            body: "{}",
          },
        ]);
      },
    );
  });

  it("exits nonzero with a compact unauthenticated message on 401", async () => {
    await withFakeSigNoz(401, { error: "unauthorized" }, async ({ url }) => {
      const result = await runCli(
        ["doctor"],
        cliEnv({
          SIGNOZ_API_URL: url,
          SIGNOZ_API_KEY: "test-secret",
        }),
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("error signoz unauthenticated status=401\n");
      expect(result.stderr).not.toContain("test-secret");
    });
  });

  it("prints structured JSON without exposing the API key", async () => {
    await withFakeSigNoz(
      400,
      { error: "invalid_input", message: "invalid input" },
      async ({ url }) => {
        const result = await runCli(
          ["doctor", "--json"],
          cliEnv({
            SIGNOZ_API_URL: url,
            SIGNOZ_API_KEY: "test-secret",
          }),
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout) as unknown).toEqual({
          ok: true,
          status: "authenticated",
          apiUrl: url,
          endpoint: "/api/v5/query_range",
          httpStatus: 400,
        });
        expect(result.stdout).not.toContain("test-secret");
      },
    );
  });
});

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<CliResult> {
  const cliPath = join(process.cwd(), "dist", "cli.js");

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliPath, ...args],
      { env },
    );

    return {
      exitCode: 0,
      stdout,
      stderr,
    };
  } catch (error) {
    const execError = error as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };

    return {
      exitCode: typeof execError.code === "number" ? execError.code : 1,
      stdout: typeof execError.stdout === "string" ? execError.stdout : "",
      stderr: typeof execError.stderr === "string" ? execError.stderr : "",
    };
  }
}

function cliEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...overrides,
  };
}

async function withFakeSigNoz(
  statusCode: number,
  responseBody: unknown,
  testFn: (context: {
    requests: CapturedRequest[];
    url: string;
  }) => Promise<void>,
): Promise<void> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    readBody(request).then((body) => {
      requests.push({
        method: request.method,
        url: request.url,
        apiKey: request.headers["signoz-api-key"],
        body,
      });

      response.writeHead(statusCode, { "content-type": "application/json" });
      response.end(JSON.stringify(responseBody));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;

  try {
    await testFn({ requests, url });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) {
          resolve();
          return;
        }

        reject(error);
      });
    });
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

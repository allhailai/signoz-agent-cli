import type { SigNozClient } from "./client.js";

export type ServerVersion = {
  version: string | null;
  rulesListApi: "v2" | "v3";
  versionProbe: "ok" | "unreachable" | "signoz_error" | "unexpected_response";
};

export async function probeServerVersion(
  client: SigNozClient,
): Promise<ServerVersion> {
  const unknown = (
    versionProbe: ServerVersion["versionProbe"],
  ): ServerVersion => ({
    version: null,
    rulesListApi: "v3",
    versionProbe,
  });

  try {
    const response = await client.getPublicJson("/api/v1/version");
    if (!response.ok) return unknown("signoz_error");

    const body = response.bodyJson;
    const version: unknown =
      typeof body === "object" && body !== null && "version" in body
        ? body.version
        : undefined;
    if (typeof version !== "string") return unknown("unexpected_response");

    const rulesListApi = rulesApiForVersion(version);
    if (rulesListApi === undefined) return unknown("unexpected_response");

    return { version, rulesListApi, versionProbe: "ok" };
  } catch {
    // Version discovery is advisory; never echo a response body or fetch error.
    return unknown("unreachable");
  }
}

function rulesApiForVersion(
  version: string,
): ServerVersion["rulesListApi"] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null || match[0] !== version) return undefined;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return undefined;
  }

  return major === 0 && minor < 144 ? "v2" : "v3";
}

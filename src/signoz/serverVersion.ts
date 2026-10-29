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
  const match =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(
      version,
    );
  if (match === null) return undefined;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const prerelease = match[4];
  if (
    ![major, minor, patch].every(Number.isSafeInteger) ||
    prerelease?.split(".").some((part) => /^0\d+$/.test(part))
  ) {
    return undefined;
  }

  // Prereleases sort before the stable 0.144.0 release that introduced v3 listing.
  return major === 0 &&
    (minor < 144 || (minor === 144 && patch === 0 && prerelease !== undefined))
    ? "v2"
    : "v3";
}

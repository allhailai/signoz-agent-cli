import { isDeepStrictEqual } from "node:util";

import { SigNozClient, type SigNozResponse } from "./client.js";

export type AlertRule = Record<string, unknown> & {
  id: string;
  alert: string;
};

export type AlertRulesPage = {
  ok: true;
  count: number;
  total: number;
  nextOffset: number | null;
  query: { limit: number; offset: number };
  rules: AlertRule[];
};

export type AlertRuleChange = {
  path: string;
  before: unknown;
  after: unknown;
};

export type AlertRuleUpdate = {
  ok: true;
  dryRun: boolean;
  verified: boolean;
  changes: AlertRuleChange[];
  rule: AlertRule;
};

export class AlertRuleError extends Error {
  constructor(
    readonly code:
      | "signoz_error"
      | "unexpected_response"
      | "invalid_patch"
      | "update_unconfirmed"
      | "verification_failed",
    message: string,
    readonly details: {
      endpoint?: string;
      httpStatus?: number;
      writeStatus?: "accepted" | "unknown";
    } = {},
  ) {
    super(message);
    this.name = "AlertRuleError";
  }
}

export async function listAlertRules(
  client: SigNozClient,
  query: AlertRulesPage["query"],
): Promise<AlertRulesPage> {
  let endpoint = `/api/v3/rules?limit=${query.limit}&offset=${query.offset}`;
  let response = await client.getJson(endpoint);
  let legacy = false;

  if (response.status === 404 || response.status === 405) {
    endpoint = "/api/v2/rules";
    response = await client.getJson(endpoint);
    legacy = true;
  }

  const data = responseData(response, endpoint);
  const page = asRecord(data);
  const rows: unknown = legacy ? data : page?.rules;
  const total = legacy && Array.isArray(rows) ? rows.length : page?.total;

  if (
    !Array.isArray(rows) ||
    !rows.every(isAlertRule) ||
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total < rows.length
  ) {
    throw unexpectedResponse(endpoint);
  }

  const rules = (
    legacy ? rows.slice(query.offset, query.offset + query.limit) : rows
  ).map(summarizeRule);
  const nextOffset = query.offset + rules.length;

  return {
    ok: true,
    count: rules.length,
    total,
    nextOffset: rules.length > 0 && nextOffset < total ? nextOffset : null,
    query,
    rules,
  };
}

export async function inspectAlertRule(
  client: SigNozClient,
  id: string,
): Promise<AlertRule> {
  const endpoint = ruleEndpoint(id);
  const response = await client.getJson(endpoint);
  const rule = responseData(response, endpoint);

  if (!isAlertRule(rule) || asRecord(rule.condition) === undefined) {
    throw unexpectedResponse(endpoint);
  }

  return rule;
}

export function parseAlertRulePatch(text: string): Record<string, unknown> {
  let patch: unknown;

  try {
    patch = JSON.parse(text) as unknown;
  } catch {
    throw new AlertRuleError(
      "invalid_patch",
      "Patch file must contain valid JSON",
    );
  }

  const record = asRecord(patch);
  if (record === undefined || Object.keys(record).length === 0) {
    throw new AlertRuleError(
      "invalid_patch",
      "Patch must be a non-empty JSON object",
    );
  }

  // Inspection envelopes and server-owned fields are not update payloads.
  const readOnlyFields = [
    "id",
    "state",
    "createAt",
    "createBy",
    "updateAt",
    "updateBy",
    "ok",
    "rule",
  ];
  if (readOnlyFields.some((field) => Object.hasOwn(record, field))) {
    throw new AlertRuleError(
      "invalid_patch",
      "Patch must contain writable rule fields, without an inspection envelope or audit fields",
    );
  }

  return record;
}

export async function updateAlertRule(
  client: SigNozClient,
  id: string,
  patch: Record<string, unknown>,
  dryRun: boolean,
): Promise<AlertRuleUpdate> {
  const rule = await inspectAlertRule(client, id);
  // SigNoz replaces some object-valued envelopes during decoding. Fill in their
  // existing fields so a partial nested edit preserves the rest of the envelope.
  const merged = mergeObjects(rule, patch);
  const payload = Object.fromEntries(
    Object.keys(patch).map((key) => [key, merged[key]]),
  );
  const changes = requestedChanges(rule, payload);

  if (dryRun || changes.length === 0) {
    return { ok: true, dryRun, verified: !dryRun, changes, rule };
  }

  const endpoint = ruleEndpoint(id);
  let response: SigNozResponse;
  try {
    response = await client.patchJson(endpoint, payload);
  } catch {
    throw new AlertRuleError(
      "update_unconfirmed",
      "Update outcome is unknown; inspect the rule before retrying",
      { endpoint, writeStatus: "unknown" },
    );
  }
  requireSuccess(response, endpoint);

  let savedRule: AlertRule;
  try {
    savedRule = await inspectAlertRule(client, id);
  } catch {
    throw new AlertRuleError(
      "verification_failed",
      "Update was accepted, but readback failed; inspect the rule before retrying",
      { endpoint, writeStatus: "accepted" },
    );
  }

  if (requestedChanges(savedRule, payload).length > 0) {
    throw new AlertRuleError(
      "verification_failed",
      "Saved rule does not match the requested changes; inspect the rule before retrying",
      { endpoint, writeStatus: "accepted" },
    );
  }

  return { ok: true, dryRun: false, verified: true, changes, rule: savedRule };
}

function requestedChanges(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
  prefix = "",
): AlertRuleChange[] {
  return Object.entries(patch).flatMap(([key, after]) => {
    const before = current[key];
    const path = `${prefix}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    const object = asRecord(after);

    if (object !== undefined && asRecord(before) !== undefined) {
      return requestedChanges(before as Record<string, unknown>, object, path);
    }

    return sameValue(before, after, path)
      ? []
      : [{ path, before: before ?? null, after }];
  });
}

function mergeObjects(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries([
    ...Object.entries(current),
    ...Object.entries(patch).map(([key, value]) => {
      const object = asRecord(value);
      const before = asRecord(current[key]);
      return [
        key,
        object !== undefined && before !== undefined
          ? mergeObjects(before, object)
          : value,
      ];
    }),
  ]);
}

const durationPaths = new Set([
  "/evalWindow",
  "/frequency",
  "/evaluation/spec/evalWindow",
  "/evaluation/spec/frequency",
  "/notificationSettings/renotify/interval",
  "/notificationSettings/newGroupEvalDelay",
]);

function sameValue(before: unknown, after: unknown, path: string): boolean {
  if (isDeepStrictEqual(before, after)) {
    return true;
  }
  // Optional rule fields can disappear from JSON when cleared.
  if (before === undefined || after === undefined) {
    const value = before === undefined ? after : before;
    return (
      value === null ||
      (Array.isArray(value) && value.length === 0) ||
      ((path === "/description" || path === "/source") && value === "")
    );
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    return (
      before.length === after.length &&
      after.every((value, index) =>
        sameValue(before[index], value, `${path}/${index}`),
      )
    );
  }
  const beforeObject = asRecord(before);
  const afterObject = asRecord(after);
  if (beforeObject !== undefined && afterObject !== undefined) {
    const keys = new Set([
      ...Object.keys(beforeObject),
      ...Object.keys(afterObject),
    ]);
    return [...keys].every((key) =>
      sameValue(
        beforeObject[key],
        afterObject[key],
        `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
      ),
    );
  }
  if (
    !durationPaths.has(path) ||
    typeof before !== "string" ||
    typeof after !== "string"
  ) {
    return false;
  }
  const duration = durationSeconds(before);
  return duration !== undefined && duration === durationSeconds(after);
}

// SigNoz serializes Go durations canonically (for example, 5m becomes 5m0s).
function durationSeconds(value: string): number | undefined {
  const units: Record<string, number> = {
    ns: 1e-9,
    us: 1e-6,
    µs: 1e-6,
    μs: 1e-6,
    ms: 0.001,
    s: 1,
    m: 60,
    h: 3600,
  };
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h)/g)];
  if (parts.length === 0 || parts.map((part) => part[0]).join("") !== value) {
    return undefined;
  }
  return parts.reduce(
    (sum, part) => sum + Number(part[1]) * (units[part[2] ?? ""] ?? 0),
    0,
  );
}

function summarizeRule(rule: AlertRule): AlertRule {
  return Object.fromEntries(
    [
      "id",
      "alert",
      "description",
      "state",
      "disabled",
      "alertType",
      "ruleType",
      "labels",
    ]
      .filter((key) => Object.hasOwn(rule, key))
      .map((key) => [key, rule[key]]),
  ) as AlertRule;
}

function responseData(response: SigNozResponse, endpoint: string): unknown {
  requireSuccess(response, endpoint);
  const body = asRecord(response.bodyJson);
  if (body?.status !== "success" || !Object.hasOwn(body, "data")) {
    throw unexpectedResponse(endpoint);
  }
  return body.data;
}

function requireSuccess(response: SigNozResponse, endpoint: string): void {
  if (!response.ok) {
    throw new AlertRuleError(
      "signoz_error",
      `SigNoz alert request failed status=${response.status}`,
      { endpoint, httpStatus: response.status },
    );
  }
}

function unexpectedResponse(endpoint: string): AlertRuleError {
  return new AlertRuleError(
    "unexpected_response",
    "SigNoz returned an unexpected alert rule response",
    { endpoint },
  );
}

function ruleEndpoint(id: string): string {
  return `/api/v2/rules/${encodeURIComponent(id)}`;
}

function isAlertRule(value: unknown): value is AlertRule {
  const rule = asRecord(value);
  return (
    typeof rule?.id === "string" &&
    rule.id.length > 0 &&
    typeof rule.alert === "string"
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

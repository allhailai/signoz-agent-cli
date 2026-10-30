import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { WriteKeySource } from "../config.js";
import {
  AlertRuleError,
  asRecord,
  inspectAlertRule,
  isAlertRule,
  listAllAlertRules,
  definitionChanges,
  requireSuccess,
  responseData,
  ruleEndpoint,
  type AlertRule,
  type AlertRuleChange,
} from "./alertRules.js";
import { SigNozClient, SigNozNetworkError } from "./client.js";

type Definition = Record<string, unknown> & {
  alert: string;
  schemaVersion: "v2alpha1";
};
type ApplyError = {
  code: string;
  message: string;
  endpoint?: string;
  httpStatus?: number;
  writeStatus?: "accepted" | "unknown";
};

export type ApplyFileResult = {
  file: string;
  alert: string | null;
  action: "create" | "update" | "unchanged" | "ambiguous" | "invalid";
  id: string | null;
  changes: AlertRuleChange[];
  test: { alertCount: number } | null;
  error: ApplyError | null;
};

export type AlertRulesApply = {
  ok: boolean;
  dryRun: boolean;
  writeKeySource: WriteKeySource;
  results: ApplyFileResult[];
};

export async function applyAlertRules(
  client: SigNozClient,
  writeClient: SigNozClient,
  directory: string,
  options: { dryRun: boolean; test: boolean; writeKeySource: WriteKeySource },
): Promise<AlertRulesApply> {
  let files: string[];
  try {
    files = (await readdir(directory))
      .filter((file) => file.endsWith(".json"))
      .sort();
  } catch {
    throw new AlertRuleError(
      "invalid_directory",
      "Unable to read rule directory",
    );
  }

  // Cache the complete inventory once, including a failed load. Never create from a partial list.
  let inventory: Promise<Array<{ rule: AlertRule; full: boolean }>> | undefined;
  const uncertainNames = new Set<string>();
  const results: ApplyFileResult[] = [];
  for (const file of files) {
    const result: ApplyFileResult = {
      file,
      alert: null,
      action: "invalid",
      id: null,
      changes: [],
      test: null,
      error: null,
    };
    results.push(result);
    try {
      const definition = await readDefinition(join(directory, file), result);
      inventory ??= listAllAlertRules(client).then(
        ({ rules, fullDefinitions }) =>
          rules.map((rule) => ({ rule, full: fullDefinitions })),
      );
      const rules = await inventory;
      const matches = rules.filter(
        ({ rule }) => rule.alert === definition.alert,
      );
      if (matches.length > 1) {
        result.action = "ambiguous";
        throw new AlertRuleError(
          "ambiguous",
          "Multiple live rules have this alert name; resolve the duplicate names before applying",
        );
      }
      const match = matches[0];
      result.action = match === undefined ? "create" : "update";
      result.id = match?.rule.id || null;
      if (uncertainNames.has(definition.alert)) {
        throw new AlertRuleError(
          "update_unconfirmed",
          "An earlier write for this alert is unverified; inspect it before retrying",
          { writeStatus: "unknown" },
        );
      }
      const current =
        match === undefined
          ? undefined
          : match.full
            ? match.rule
            : await inspectAlertRule(client, match.rule.id);
      result.changes = definitionChanges(current ?? {}, definition);
      if (result.changes.length === 0) {
        result.action = "unchanged";
        continue;
      }

      let saved: AlertRule;
      if (options.dryRun) {
        // Simulate earlier files so repeated names in a directory have the same plan as a real run.
        saved = { ...definition, id: result.id ?? "" };
      } else {
        if (options.test)
          result.test = await testDefinition(writeClient, definition);
        if (match === undefined) {
          const created = await createDefinition(writeClient, definition);
          result.id = created.id;
        } else {
          await replaceDefinition(writeClient, match.rule.id, definition);
        }
        saved = await verifyDefinition(client, result.id!, definition);
      }
      if (match === undefined) rules.push({ rule: saved, full: true });
      else {
        match.rule = saved;
        match.full = true;
      }
    } catch (error) {
      result.error = applyError(error);
      if (result.alert !== null && result.error.writeStatus !== undefined)
        uncertainNames.add(result.alert);
    }
  }
  return {
    ok: results.every(({ error }) => error === null),
    dryRun: options.dryRun,
    writeKeySource: options.writeKeySource,
    results,
  };
}

async function readDefinition(
  file: string,
  result: ApplyFileResult,
): Promise<Definition> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    throw new AlertRuleError(
      "invalid_definition",
      "Rule file must be readable, valid JSON",
    );
  }
  const definition = asRecord(value);
  if (typeof definition?.alert === "string") result.alert = definition.alert;
  const serverFields = [
    "id",
    "state",
    "createdAt",
    "createdBy",
    "updatedAt",
    "updatedBy",
  ];
  if (
    definition === undefined ||
    definition.schemaVersion !== "v2alpha1" ||
    typeof definition.alert !== "string" ||
    definition.alert.trim() === "" ||
    serverFields.some((field) => Object.hasOwn(definition, field))
  ) {
    throw new AlertRuleError(
      "invalid_definition",
      'Rule must have schemaVersion "v2alpha1", a non-empty alert, and no id, state, createdAt, createdBy, updatedAt, or updatedBy fields',
    );
  }
  return definition as Definition;
}

async function testDefinition(
  client: SigNozClient,
  definition: Definition,
): Promise<{ alertCount: number }> {
  const endpoint = "/api/v2/rules/test";
  let response;
  try {
    response = await client.postJson(endpoint, definition);
  } catch {
    throw new AlertRuleError(
      "test_failed",
      "Test notification outcome is unknown; no rule write was attempted",
      { endpoint },
    );
  }
  const count = asRecord(response.bodyJson)?.alertCount;
  if (
    !response.ok ||
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 0
  ) {
    throw new AlertRuleError(
      "test_failed",
      "Rule test failed or returned an unexpected response; no rule write was attempted",
      { endpoint, httpStatus: response.status },
    );
  }
  return { alertCount: count };
}

async function createDefinition(
  client: SigNozClient,
  definition: Definition,
): Promise<AlertRule> {
  const endpoint = "/api/v2/rules";
  let response;
  try {
    response = await client.postJson(endpoint, definition);
  } catch {
    throw new AlertRuleError(
      "update_unconfirmed",
      "Create outcome is unknown; list and inspect the rule before retrying",
      { endpoint, writeStatus: "unknown" },
    );
  }
  requireSuccess(response, endpoint);
  try {
    const rule = responseData(response, endpoint);
    if (response.status === 201 && isAlertRule(rule)) return rule;
  } catch {
    // A success status without a usable id may have created a rule. Do not retry it.
  }
  throw new AlertRuleError(
    "update_unconfirmed",
    "Create returned no confirmed rule id; list and inspect the rule before retrying",
    { endpoint, writeStatus: "unknown" },
  );
}

async function replaceDefinition(
  client: SigNozClient,
  id: string,
  definition: Definition,
): Promise<void> {
  const endpoint = ruleEndpoint(id);
  let response;
  try {
    response = await client.putJson(endpoint, definition);
  } catch {
    throw new AlertRuleError(
      "update_unconfirmed",
      "Update outcome is unknown; inspect the rule before retrying",
      { endpoint, writeStatus: "unknown" },
    );
  }
  requireSuccess(response, endpoint);
  // PUT returns 204 with no body. Only readback can establish the saved definition.
}

async function verifyDefinition(
  client: SigNozClient,
  id: string,
  definition: Definition,
): Promise<AlertRule> {
  const endpoint = ruleEndpoint(id);
  let rule: AlertRule;
  try {
    rule = await inspectAlertRule(client, id);
  } catch {
    throw new AlertRuleError(
      "verification_failed",
      "Write was accepted, but readback failed; inspect the rule before retrying",
      { endpoint, writeStatus: "accepted" },
    );
  }
  if (definitionChanges(rule, definition).length > 0) {
    throw new AlertRuleError(
      "verification_failed",
      "Saved rule does not match the requested definition; inspect the rule before retrying",
      { endpoint, writeStatus: "accepted" },
    );
  }
  return rule;
}

function applyError(error: unknown): ApplyError {
  if (error instanceof AlertRuleError)
    return { code: error.code, message: error.message, ...error.details };
  if (error instanceof SigNozNetworkError)
    return { code: "unreachable", message: error.message };
  return { code: "unexpected_response", message: "Unable to apply rule file" };
}

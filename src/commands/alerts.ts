import { readFile } from "node:fs/promises";

import { Command, InvalidArgumentError } from "commander";

import { ConfigError, loadConfig, writeConfig } from "../config.js";
import {
  formatAlertRulesListText,
  formatAlertRuleText,
  formatAlertRuleUpdateText,
  formatAlertRulesApplyText,
} from "../output/alerts.js";
import {
  AlertRuleError,
  inspectAlertRule,
  listAlertRules,
  parseAlertRulePatch,
  updateAlertRule,
} from "../signoz/alertRules.js";
import { SigNozClient, SigNozNetworkError } from "../signoz/client.js";
import { applyAlertRules } from "../signoz/alertRuleApply.js";

type OutputOptions = { json?: boolean };
type ListOptions = OutputOptions & { limit: number; offset: number };
type UpdateOptions = OutputOptions & { patchFile: string; dryRun?: boolean };
type ApplyOptions = OutputOptions & {
  dir: string;
  dryRun?: boolean;
  test?: boolean;
};

export function registerAlertsCommand(program: Command): void {
  const alerts = program
    .command("alerts")
    .description(
      "List, inspect, update, and apply configured SigNoz alert rules.",
    );

  alerts
    .command("list")
    .description(
      "List alert rule summaries, including inactive and disabled rules.",
    )
    .option("--limit <n>", "Maximum rules to return (1-200).", parseLimit, 20)
    .option("--offset <n>", "Number of rules to skip.", parseOffset, 0)
    .option("--json", "Print structured JSON output.")
    .action(async (options: ListOptions) => {
      await runCommand("list", options, async () => {
        const result = await listAlertRules(new SigNozClient(loadConfig()), {
          limit: options.limit,
          offset: options.offset,
        });
        return { result, text: formatAlertRulesListText(result) };
      });
    });

  alerts
    .command("inspect")
    .description("Read the full definition of an alert rule by ID.")
    .argument("<rule-id>", "Full alert rule ID.")
    .option("--json", "Print structured JSON output.")
    .action(async (id: string, options: OutputOptions) => {
      await runCommand("inspect", options, async () => {
        const rule = await inspectAlertRule(new SigNozClient(loadConfig()), id);
        return { result: { ok: true, rule }, text: formatAlertRuleText(rule) };
      });
    });

  alerts
    .command("update")
    .description(
      "Apply partial rule JSON; arrays replace the entire stored array.",
    )
    .argument("<rule-id>", "Full alert rule ID.")
    .requiredOption(
      "--patch-file <file>",
      "Partial rule JSON file, or - for stdin.",
    )
    .option(
      "--dry-run",
      "Preview requested changes without writing or server validation.",
    )
    .option("--json", "Print structured JSON output.")
    .action(async (id: string, options: UpdateOptions) => {
      await runCommand("update", options, async () => {
        const config = loadConfig();
        const client = new SigNozClient(config);
        const write = writeConfig(config);
        const patch = parseAlertRulePatch(
          await readPatchFile(options.patchFile),
        );
        const result = await updateAlertRule(
          client,
          id,
          patch,
          options.dryRun === true,
          new SigNozClient(write.config),
        );
        return {
          result: { ...result, writeKeySource: write.writeKeySource },
          text: `${formatAlertRuleUpdateText(result)}Writes use ${write.writeKeySource}.\n`,
        };
      });
    });

  alerts
    .command("apply")
    .description(
      "Apply full v2alpha1 rule definitions from a directory, matched by alert name.",
    )
    .requiredOption("--dir <dir>", "Directory containing rule JSON files.")
    .option(
      "--dry-run",
      "Preview changes without writes or test notifications.",
    )
    .option(
      "--test",
      "Send a real test notification before each create or update.",
    )
    .option("--json", "Print structured JSON output.")
    .action(async (options: ApplyOptions) => {
      await runCommand("apply", options, async () => {
        const config = loadConfig();
        const write = writeConfig(config);
        const result = await applyAlertRules(
          new SigNozClient(config),
          new SigNozClient(write.config),
          options.dir,
          {
            dryRun: options.dryRun === true,
            test: options.test === true,
            writeKeySource: write.writeKeySource,
          },
        );
        return { result, text: formatAlertRulesApplyText(result) };
      });
    });
}

async function runCommand(
  command: string,
  options: OutputOptions,
  run: () => Promise<{ result: { ok: boolean }; text: string }>,
): Promise<void> {
  try {
    const { result, text } = await run();
    const stream = result.ok ? process.stdout : process.stderr;
    stream.write(
      redactKeys(options.json === true ? `${JSON.stringify(result)}\n` : text),
    );
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    const failure = {
      ...formatFailure(command, error),
      ...(command === "apply" || command === "update"
        ? {
            writeKeySource: process.env.SIGNOZ_WRITE_API_KEY?.trim()
              ? "SIGNOZ_WRITE_API_KEY"
              : "SIGNOZ_API_KEY",
          }
        : {}),
    };
    process.stderr.write(
      redactKeys(
        options.json === true
          ? `${JSON.stringify(failure)}\n`
          : `error ${failure.message}${"writeKeySource" in failure ? ` writes=${failure.writeKeySource}` : ""}\n`,
      ),
    );
    process.exitCode = 1;
  }
}

function redactKeys(text: string): string {
  for (const value of [
    process.env.SIGNOZ_API_KEY,
    process.env.SIGNOZ_WRITE_API_KEY,
  ]) {
    const key = value?.trim();
    if (key) text = text.replaceAll(key, "[REDACTED]");
  }
  return text;
}

function formatFailure(
  command: string,
  error: unknown,
): Record<string, unknown> & { message: string } {
  const base = { ok: false, command: `alerts ${command}` };
  if (error instanceof AlertRuleError) {
    return {
      ...base,
      code: error.code,
      message: error.message,
      ...error.details,
    };
  }
  if (error instanceof ConfigError) {
    return {
      ...base,
      code: error.code,
      message: error.message,
      missingVariables: error.missingVariables,
    };
  }
  if (error instanceof SigNozNetworkError) {
    return { ...base, code: "unreachable", message: error.message };
  }
  return {
    ...base,
    code: "unexpected_response",
    message: `Unable to run alerts ${command}`,
  };
}

async function readPatchFile(file: string): Promise<string> {
  try {
    if (file !== "-") {
      return await readFile(file, "utf8");
    }
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    throw new AlertRuleError("invalid_patch", "Unable to read patch file");
  }
}

function parseLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new InvalidArgumentError("Limit must be an integer from 1 to 200");
  }
  return limit;
}

function parseOffset(value: string): number {
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new InvalidArgumentError("Offset must be a non-negative integer");
  }
  return offset;
}

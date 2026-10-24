import type {
  AlertRule,
  AlertRulesPage,
  AlertRuleUpdate,
} from "../signoz/alertRules.js";

export function formatAlertRulesListText(page: AlertRulesPage): string {
  const lines = [
    `${page.count} alert rules total=${page.total} offset=${page.query.offset}`,
    "",
  ];
  for (const rule of page.rules) {
    lines.push(
      `${rule.id} ${JSON.stringify(rule.alert)} state=${String(rule.state ?? "?")} disabled=${String(rule.disabled ?? "?")} type=${String(rule.alertType ?? "?")} labels=${JSON.stringify(rule.labels ?? {})}`,
    );
  }
  if (page.rules[0] !== undefined) {
    lines.push(
      "",
      "Next:",
      `- signoz-agent alerts inspect ${page.rules[0].id}`,
    );
  }
  if (page.nextOffset !== null) {
    lines.push(
      `- signoz-agent alerts list --limit ${page.query.limit} --offset ${page.nextOffset}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function formatAlertRuleText(rule: AlertRule): string {
  // Keep every query type and schema field visible, including unfamiliar fields.
  return `alert ${rule.id} ${JSON.stringify(rule.alert)}\n${JSON.stringify(rule, null, 2)}\n`;
}

export function formatAlertRuleUpdateText(result: AlertRuleUpdate): string {
  const lines = [
    result.dryRun
      ? `Preview for alert ${result.rule.id}; no write or server validation performed.`
      : `Alert ${result.rule.id} verified after update.`,
  ];
  if (result.changes.length === 0) {
    lines.push("No changes requested.");
  }
  for (const change of result.changes) {
    lines.push(
      `\n${change.path}`,
      `- ${JSON.stringify(change.before, null, 2)}`,
      `+ ${JSON.stringify(change.after, null, 2)}`,
    );
  }
  if (!result.dryRun) {
    lines.push("", formatAlertRuleText(result.rule).trimEnd());
  }
  return `${lines.join("\n")}\n`;
}

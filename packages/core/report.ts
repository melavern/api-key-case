import type { ScanReport } from "./scanner.js";

export function renderTextReport(report: ScanReport): string {
  const lines: string[] = [];

  lines.push("API Key Case scan");
  lines.push(`Target: ${report.targetDir}`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("Security note: this tool reduces accident risk; it does not guarantee complete safety.");
  lines.push("Secret values are never printed by this report.");
  lines.push("");

  lines.push("Git ignore");
  lines.push(`- .gitignore: ${report.gitignore.hasGitignore ? "found" : "missing"}`);
  lines.push(`- .env ignored: ${status(report.gitignore.ignoresDotEnv)}`);
  lines.push(`- .env.* ignored: ${status(report.gitignore.ignoresDotEnvVariants)}`);
  lines.push("");

  lines.push("Env files");
  if (report.envFiles.length === 0) {
    lines.push("- none found");
  } else {
    for (const envFile of report.envFiles) {
      lines.push(
        `- ${envFile.file}: ignored=${yesNo(envFile.ignored)}, tracked=${yesNo(envFile.tracked)}, history=${yesNo(envFile.seenInHistory)}`
      );
    }
  }
  lines.push("");

  lines.push("Required secrets");
  if (report.requiredSecrets.length === 0) {
    lines.push(
      "- none detected by the current API Key Case scanner (this does not prove that the project needs no secrets)"
    );
  } else {
    for (const name of report.requiredSecrets) {
      lines.push(`- ${name}`);
    }
  }
  lines.push("");

  lines.push("Possible leaks");
  if (report.secretFindings.length === 0) {
    lines.push("- none detected");
  } else {
    for (const finding of report.secretFindings) {
      lines.push(`- ${finding.file}:${finding.line} ${finding.kind}: ${finding.preview}`);
    }
  }
  lines.push("");

  lines.push(".env.example");
  if (report.envExample.written) {
    lines.push(`- wrote ${report.envExample.path}`);
  } else if (report.envExample.reason) {
    lines.push(`- ${report.envExample.reason}`);
  } else {
    lines.push("- preview only; rerun with --write-env-example to write");
    for (const line of report.envExample.content.trimEnd().split("\n")) {
      lines.push(`  ${line}`);
    }
  }
  lines.push("");

  if (report.agentReport.requested) {
    lines.push("Agent report");
    for (const file of report.agentReport.files) {
      if (file.written) {
        lines.push(`- wrote ${file.path}`);
      } else {
        lines.push(`- preserved ${file.path}: ${file.reason ?? "not written"}`);
      }
    }
    lines.push("");
  }

  lines.push("Warnings");
  if (report.warnings.length === 0) {
    lines.push("- none");
  } else {
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function status(value: boolean): string {
  return value ? "OK" : "WARN";
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

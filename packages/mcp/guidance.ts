import { realpathSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { scanProject, type ScanReport } from "../core/scanner.js";

/** Deliberately no Vault, adapter, Human Plane, provider client or write dependency. */
export interface GuidanceDeps {
  projectDir: string;
  scan?: (options: { targetDir: string; skipGitInspection: true }) => ScanReport;
}

const KNOWN_NAMES = new Map([
  ["OPENAI_API_KEY", "openai"], ["RESEND_API_KEY", "resend"],
  ["STRIPE_SECRET_KEY", "stripe"], ["STRIPE_TEST_SECRET_KEY", "stripe"]
]);
const ERROR: CallToolResult = {
  isError: true,
  content: [{ type: "text", text: "Setup requirements could not be inspected. No credential or provider status was established." }]
};

export function buildGuidanceHandler(deps: GuidanceDeps) {
  // Bind once at trusted server startup, never from MCP arguments.
  let bound: string;
  try { bound = realpathSync.native(deps.projectDir); }
  catch { throw new Error("Guidance requires an existing fixed project directory."); }
  const scan = deps.scan ?? scanProject;
  return async (args: Record<string, unknown>): Promise<CallToolResult> => {
    if (args === null || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 0) return ERROR;
    try {
      if (realpathSync.native(deps.projectDir) !== bound) return ERROR;
      const report = scan({ targetDir: bound, skipGitInspection: true });
      const names = [...new Set(report.requiredSecrets)];
      const known = [...new Set(names.flatMap((name) => KNOWN_NAMES.has(name) ? [KNOWN_NAMES.get(name)!] : []))].sort();
      const summary = {
        schemaVersion: 1,
        profile: "guidance-only",
        requirements: {
          status: names.length > 0 ? "detected" : "none-detected",
          count: names.length,
          knownServices: known,
          otherNameCount: names.filter((name) => !KNOWN_NAMES.has(name)).length
        },
        possibleExposureCount: report.secretFindings.length,
        credentialStatus: "not-inspected",
        providerStatus: "not-inspected",
        destinationStatus: "not-inspected",
        gitHistoryStatus: "not-inspected",
        nextStep: report.secretFindings.length > 0 ? "human-review-possible-exposure" : "review-existing-local-setup",
        writesPerformed: false,
        providerCallsPerformed: false,
        secretStoreAccessPerformed: false
      };
      return {
        content: [{ type: "text", text: "Project requirements only. Existing credentials and setup have not been inspected; do not ask for re-registration or treat no detected requirement as proof none is needed. Secret entry and approval stay in the independent Human Plane." }],
        structuredContent: summary
      };
    } catch { return ERROR; }
  };
}

export function registerGuidanceTools(server: McpServer, projectDir: string): void {
  server.registerTool("inspect_setup_requirements", {
    description: "Read-only requirement counts for the fixed local project. No paths, secret values or approval arguments. Does not inspect the vault or prove provider readiness.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, buildGuidanceHandler({ projectDir }));
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { WindowsHumanPlane, resolveWindowsPowerShell } from "../core/human/windows.js";
import { CatalogStore } from "../core/vnext/files.js";
import { VNEXT_WINDOWS_REGISTRATION_ACCEPTED } from "../core/vnext/gates.js";
import { capabilities } from "../core/vnext/status.js";
import { discoverCredentials, inspectLegacyCandidates, inspectLegacyStatus, type DiscoveryIO } from "../core/vnext/discovery.js";
import { inspectProject, sameProject, findProject } from "../core/vnext/project.js";
import { prepareBinding, projectBindingPlan } from "../core/vnext/binding.js";
import { prepareUse, projectUsePlan, useOperationStatus } from "../core/vnext/use.js";
import { prepareHostedUse, projectHostedUsePlan } from "../core/vnext/hosted-use.js";
import { prepareLaunch, projectLaunchPlan, launchOperationStatus } from "../core/vnext/launch.js";
import { ProFeatureError, assertProFeature, type LicenseOptions } from "../core/license.js";
import { variableSchema } from "../core/vnext/model.js";

// Read-only dependencies. No input, approval, provider, handoff or catalog writer.
export interface VNextMcpDeps extends DiscoveryIO {
  store: Pick<CatalogStore, "readCatalog" | "readOperation" | "listUseOperations" | "listLaunchOperations">;
  licenseOptions?: LicenseOptions;
  backend(): Promise<"available" | "unavailable">;
}
const query = { environment: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/).optional(), variable: variableSchema.optional() };
const binding = { ...query, environment: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/), variable: variableSchema,
  credentialId: z.uuidv4().optional(), risk: z.enum(["unknown", "nonproduction", "production"]).optional() };
const use = { bindingId: z.uuidv4().optional(), targetId: z.uuidv4().optional(), profileId: z.uuidv4().optional() };
const specs = {
  secret_capabilities: {}, discover_credentials: query, request_secret_input: query, plan_secret_binding: binding,
  plan_secret_use: use, request_secret_use: use, get_secret_operation_status: { operationId: z.uuidv4() }
};
type ToolName = keyof typeof specs;
function result(summary: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: "Status only. Secret entry, selection and fresh approval require the independent local Human Plane. This response grants no permission and performs no operation." }],
    structuredContent: { ...summary, permission: "none", executed: false } };
}
const unavailable = () => result({ schemaVersion: 1, status: "unavailable", humanAction: "review-fixed-local-project-with-cli" });
function nativeDeps(): VNextMcpDeps {
  const store = new CatalogStore(), human = new WindowsHumanPlane(resolveWindowsPowerShell());
  const accepted = process.platform === "win32" && VNEXT_WINDOWS_REGISTRATION_ACCEPTED;
  const presence: DiscoveryIO["presence"] = Object.assign(
    (locator: Parameters<WindowsHumanPlane["probeVNextPresence"]>[0]) => accepted ? human.probeVNextPresence(locator) : Promise.resolve("unavailable" as const),
    { all: (locators: Parameters<WindowsHumanPlane["probeVNextPresenceBatch"]>[0]) => accepted ? human.probeVNextPresenceBatch(locators) : Promise.resolve(locators.map(() => "unavailable" as const)) });
  return { store, presence, legacyStatus: inspectLegacyStatus,
    legacy: context => accepted ? inspectLegacyCandidates(context, presence) : Promise.resolve({ status: "unavailable", locators: [] }),
    backend: async () => accepted && await presence({ kind: "v3", id: "00000000-0000-4000-8000-000000000001", generationId: "00000000-0000-4000-8000-000000000002" }) !== "unavailable" ? "available" : "unavailable" };
}
export function buildVNextHandler(projectDir: string, provided?: VNextMcpDeps) {
  // Bind the physical directory once; caller arguments never select another project.
  const context = inspectProject(projectDir);
  let deps = provided;
  return async (name: ToolName, input: unknown): Promise<CallToolResult> => {
    try {
      const args = z.strictObject(specs[name]).parse(input) as Record<string, string | undefined>;
      if (!sameProject(context, inspectProject(projectDir))) return unavailable();
      // Every use request, including a plan, checks entitlement before metadata.
      if (name === "plan_secret_use" || name === "request_secret_use") assertProFeature("deploy", deps?.licenseOptions);
      const io = deps ??= nativeDeps();
      let summary: Record<string, unknown>;
      if (name === "secret_capabilities") summary = capabilities(process.platform, await io.backend());
      else if (name === "discover_credentials" || name === "request_secret_input") {
        const report = await discoverCredentials({ project: context.canonicalPath, ...args }, io);
        summary = { ...report, humanAction: report.status === "registered" ? "reuse-existing-binding" : "review-existing-registration-and-binding-with-local-cli" };
        if (name === "request_secret_input") summary = { ...summary, status: "action-required", discovery: report,
          inputRequested: false, humanAction: "review-existing-registration-first-then-use-secret-input-cli-only-if-needed" };
      } else if (name === "plan_secret_binding") {
        summary = { ...projectBindingPlan(await prepareBinding({ project: context.canonicalPath, ...args } as Parameters<typeof prepareBinding>[0], io)),
          humanAction: "review-binding-with-local-cli" };
      } else if (name === "plan_secret_use" || name === "request_secret_use") {
        if (args.profileId && !args.bindingId && !args.targetId) summary = projectLaunchPlan(prepareLaunch({ project: context.canonicalPath, profileId: args.profileId }, io));
        else if (args.bindingId && args.targetId && !args.profileId) {
          const target = io.store.readCatalog()?.catalog.destinations.find(d => d.id === args.targetId);
          const request = { project: context.canonicalPath, bindingId: args.bindingId, targetId: args.targetId };
          summary = target?.kind === "cloudflare" ? projectUsePlan(prepareUse(request, io)) : projectHostedUsePlan(prepareHostedUse(request, io));
        } else return unavailable();
        summary = { ...summary, humanAction: args.profileId ? "review-launch-and-complete-fresh-local-os-verification" : "review-placement-and-complete-fresh-local-os-verification",
          ...(name === "request_secret_use" ? { status: "action-required", operationRequested: false } : {}) };
      } else {
        const catalog = io.store.readCatalog()?.catalog, project = catalog && findProject(catalog, context);
        const operation = io.store.readOperation(args.operationId!)?.operation;
        if (!catalog || !project || !operation || (operation.projectId ? operation.projectId !== project.id :
          !operation.credentialId || !catalog.bindings.some(b => b.projectId === project.id && b.credentialId === operation.credentialId))) return unavailable();
        const observation = operation.kind === "local-launch" ? launchOperationStatus(operation.operationId, io.store) :
          ["cloudflare-use", "vercel-use", "github-use"].includes(operation.kind) ? useOperationStatus(operation.operationId, io.store) :
            { status: operation.state === "executing" ? "unknown" : operation.state };
        // Never return journal basis, candidate catalog, labels, paths or effects.
        summary = { schemaVersion: 1, status: observation.status, kind: operation.kind, operationId: operation.operationId,
          replay: "not-permitted", humanAction: "observe-or-recover-with-local-cli-without-repeating-execution" };
      }
      return sameProject(context, inspectProject(projectDir)) ? result(summary) : unavailable();
    } catch (error) { return error instanceof ProFeatureError ? result({ schemaVersion: 1, status: "pro-required" }) : unavailable(); }
  };
}
export function registerVNextTools(server: McpServer, projectDir: string, deps?: VNextMcpDeps): void {
  const handler = buildVNextHandler(projectDir, deps);
  for (const [name, inputSchema] of Object.entries(specs)) server.registerTool(name, {
    description: "Fixed-project status and human-action guidance only. No values, paths, URLs, execution, input or approval arguments. Use plans require Pro; operation status never replays work.",
    // Preserve unknown fields until our closed parser can reject them with a
    // fixed response. SDK validation errors can echo caller-controlled keys.
    inputSchema: z.looseObject(Object.fromEntries(Object.keys(inputSchema).map(key => [key, z.unknown().optional()]))),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, (args: Record<string, unknown>) => handler(name as ToolName, args));
}

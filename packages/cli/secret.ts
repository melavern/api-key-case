import { WindowsHumanPlane, resolveWindowsPowerShell } from "../core/human/windows.js";
import { CatalogStore } from "../core/vnext/files.js";
import { VNEXT_WINDOWS_REGISTRATION_ACCEPTED, VNEXT_WINDOWS_BINDING_ACCEPTED } from "../core/vnext/gates.js";
import { inputRequestSchema, inputResult, registerCredential } from "../core/vnext/input.js";
import { capabilities } from "../core/vnext/status.js";
import { discoverCredentials, inspectLegacyCandidates, inspectLegacyStatus, type DiscoveryIO } from "../core/vnext/discovery.js";
import { applyBinding, bindingResult, prepareBinding, projectBindingPlan, recoverBinding, type BindingIO } from "../core/vnext/binding.js";
import { applyManagement, manageRequestSchema, prepareManagement, projectManagementPlan, type ManageIO } from "../core/vnext/manage.js";
import { prepareTarget, projectTargetPlan, registerTarget, type TargetIO } from "../core/vnext/target.js";
import { applyUse, prepareUse, projectUsePlan, useOperationStatus, type UseIO } from "../core/vnext/use.js";
import { runGenericCloudflareDeployment, runGenericLocalApplication } from "../core/deploy/handoff.js";
import { listProfiles, prepareProfile, projectProfilePlan, registerProfile, prepareLaunch, projectLaunchPlan, applyLaunch, launchOperationStatus,
  type ProfileIO, type LaunchIO, type ProfileRequest } from "../core/vnext/launch.js";
import { prepareHostedTarget, projectHostedTargetPlan, registerHostedTarget, type HostedTargetIO } from "../core/vnext/hosted-target.js";
import { prepareHostedUse, projectHostedUsePlan, applyHostedUse, type HostedUseIO } from "../core/vnext/hosted-use.js";
import { runGenericHostedDeployment } from "../core/deploy/handoff.js";
import { ProFeatureError, assertProFeature } from "../core/license.js";

// Internal dependency injection for isolated acceptance. There is no CLI flag or
// environment override for a home directory, Human Plane or approval result.
export type SecretMetadataServices = BindingIO & { store: BindingIO["store"] & Pick<CatalogStore, "withUseLock" | "listUseOperations" | "listLaunchOperations">;
  managementHuman: ManageIO["human"]; targetHuman?: TargetIO["human"]; useHuman?: UseIO["human"]; profileHuman?: ProfileIO["human"]; launchHuman?: LaunchIO["human"];
  hostedTargetHuman?: HostedTargetIO["human"]; hostedUseHuman?: HostedUseIO["human"] };
function nativeMetadataServices(): SecretMetadataServices {
  const human = new WindowsHumanPlane(resolveWindowsPowerShell()), store = new CatalogStore();
  const presence: DiscoveryIO["presence"] = Object.assign((locator: Parameters<WindowsHumanPlane["probeVNextPresence"]>[0]) => human.probeVNextPresence(locator),
    { all: (locators: Parameters<WindowsHumanPlane["probeVNextPresenceBatch"]>[0]) => human.probeVNextPresenceBatch(locators) });
  return { store, presence, legacyStatus: inspectLegacyStatus, legacy: context => inspectLegacyCandidates(context, presence),
    human: { choose: plan => human.chooseVNextBinding(plan) }, managementHuman: { confirm: plan => human.confirmVNextManagement(plan) },
    targetHuman: { choose: plan => human.chooseVNextTarget(plan) }, useHuman: { approve: (plan, path) => human.approveVNextUse(plan, path) },
    profileHuman: { confirm: plan => human.confirmVNextProfile(plan) }, launchHuman: { approve: plan => human.approveVNextLaunch(plan) },
    hostedTargetHuman: { confirm: plan => human.confirmVNextHostedTarget(plan) }, hostedUseHuman: { approve: (plan, path) => human.approveVNextHostedUse(plan, path) } };
}

function args(input: string[], allowed: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < input.length; i++) {
    const key = input[i];
    if (key === "--json") { if (key in result) throw Error(); result[key] = "true"; continue; }
    if (!allowed.includes(key) || key in result || !input[i + 1] || input[i + 1].startsWith("--")) throw Error();
    result[key] = input[++i];
  }
  return result;
}
export async function runSecretCommand(argv: string[], metadataServices?: SecretMetadataServices): Promise<number> {
  let output: unknown, success = true;
  try {
    const [command, ...rest] = argv;
    if (command === "capabilities") {
      args(rest, []);
      let backend: "available" | "unavailable" = "unavailable";
      if (process.platform === "win32" && VNEXT_WINDOWS_REGISTRATION_ACCEPTED) {
        const human = new WindowsHumanPlane(resolveWindowsPowerShell());
        const state = await human.probeVNextPresence({ kind: "v3", id: "00000000-0000-4000-8000-000000000001", generationId: "00000000-0000-4000-8000-000000000002" });
        if (state !== "unavailable") backend = "available";
      }
      output = capabilities(process.platform, backend);
    } else if (command === "input") {
      const parsed = args(rest, ["--label", "--classification", "--replace", "--operation"]);
      const request = inputRequestSchema.safeParse({
        ...(parsed["--label"] ? { label: parsed["--label"] } : {}),
        ...(parsed["--classification"] ? { classification: parsed["--classification"] } : {}),
        ...(parsed["--replace"] ? { replaceCredentialId: parsed["--replace"] } : {}),
        ...(parsed["--operation"] ? { operationId: parsed["--operation"] } : {})
      });
      if (!request.success) throw Error();
      // This is a source gate, never a caller option, environment override or approval token.
      if (process.platform !== "win32" || !VNEXT_WINDOWS_REGISTRATION_ACCEPTED) {
        output = inputResult(process.platform === "win32" ? "pending-acceptance" : "unavailable"); success = false;
      } else {
        const human = new WindowsHumanPlane(resolveWindowsPowerShell());
        const result = await registerCredential(request.data, { store: new CatalogStore(), human: { ask: plan => human.askVNextSecret(plan) },
          presence: locator => human.probeVNextPresence(locator) });
        output = result; success = result.status === "committed" || result.status === "cancelled";
      }
    } else if (command === "discover" || command === "binding" || command === "manage") {
      const verb = command !== "discover" ? rest.shift() : null;
      if (command !== "discover" && verb !== "plan" && verb !== "apply") throw Error();
      const parsed = args(rest, command === "discover" ? ["--project", "--environment", "--variable"] :
        command === "manage" ? ["--action", "--binding", "--project", "--risk", "--fingerprint", "--operation"] :
        ["--project", "--environment", "--variable", "--credential", "--risk", "--fingerprint", "--operation"]);
      if (process.platform !== "win32" || !VNEXT_WINDOWS_REGISTRATION_ACCEPTED) throw Error();
      const io = metadataServices ?? nativeMetadataServices(), { store } = io;
      const request = { project: parsed["--project"] ?? process.cwd(), ...(parsed["--environment"] ? { environment: parsed["--environment"] } : {}),
        ...(parsed["--variable"] ? { variable: parsed["--variable"] } : {}) };
      if (command === "discover") output = await discoverCredentials(request, io);
      else if (parsed["--operation"]) {
        if (verb !== "apply" || Object.keys(parsed).some(k => !["--operation", "--json"].includes(k))) throw Error();
        output = recoverBinding(parsed["--operation"], store);
      } else if (command === "manage") {
        if (verb === "plan" && parsed["--fingerprint"]) throw Error();
        const management = manageRequestSchema.parse({ action: parsed["--action"], bindingId: parsed["--binding"],
          ...(parsed["--project"] ? { project: parsed["--project"] } : {}), ...(parsed["--risk"] ? { risk: parsed["--risk"] } : {}) });
        const managementIO = { store, human: io.managementHuman };
        output = verb === "plan" ? projectManagementPlan(prepareManagement(management, managementIO)) : !VNEXT_WINDOWS_BINDING_ACCEPTED ? bindingResult("pending-acceptance") :
          await applyManagement(management, parsed["--fingerprint"] ?? "", managementIO);
      } else {
        if (!request.environment || !request.variable || verb === "plan" && parsed["--fingerprint"]) throw Error();
        const binding = { ...request, environment: request.environment, variable: request.variable,
          ...(parsed["--credential"] ? { credentialId: parsed["--credential"] } : {}), ...(parsed["--risk"] ? { risk: parsed["--risk"] as "unknown" } : {}) };
        output = verb === "plan" ? projectBindingPlan(await prepareBinding(binding, io)) : !VNEXT_WINDOWS_BINDING_ACCEPTED ? bindingResult("pending-acceptance") :
          await applyBinding(binding, parsed["--fingerprint"] ?? "", io);
      }
    } else if (command === "target") {
      const verb = rest.shift();
      if (verb !== "inspect" && verb !== "register") throw Error();
      const parsed = args(rest, ["--project", "--environment", "--config", "--kind", "--fingerprint", "--operation"]);
      if (process.platform !== "win32" || !VNEXT_WINDOWS_BINDING_ACCEPTED) throw Error();
      const io = metadataServices ?? nativeMetadataServices();
      if (parsed["--operation"]) {
        if (verb !== "register" || Object.keys(parsed).some(k => !["--operation", "--json"].includes(k))) throw Error();
        output = recoverBinding(parsed["--operation"], io.store);
      } else {
        if (verb === "inspect" && parsed["--fingerprint"] || !parsed["--environment"]) throw Error();
        const request = { project: parsed["--project"] ?? process.cwd(), environment: parsed["--environment"], ...(parsed["--config"] ? { config: parsed["--config"] } : {}) };
        const kind = parsed["--kind"] ?? "cloudflare";
        if (kind === "cloudflare") output = verb === "inspect" ? projectTargetPlan(prepareTarget(request, io)) : await registerTarget(request, parsed["--fingerprint"] ?? "",
          { store: io.store, human: io.targetHuman ?? { choose: async () => ({ status: "unavailable" }) } });
        else {
          if (!["vercel", "github-actions"].includes(kind) || parsed["--config"]) throw Error();
          const hostedRequest = { project: request.project, environment: request.environment, kind: kind as "vercel" | "github-actions" }, hostedIO = { store: io.store, human: io.hostedTargetHuman ?? { confirm: async () => "unavailable" as const } };
          output = verb === "inspect" ? projectHostedTargetPlan(prepareHostedTarget(hostedRequest, hostedIO)) : await registerHostedTarget(hostedRequest, parsed["--fingerprint"] ?? "", hostedIO);
        }
      }
    } else if (command === "use") {
      const verb = rest.shift();
      if (verb !== "plan" && verb !== "apply") throw Error();
      const parsed = args(rest, ["--project", "--binding", "--target", "--fingerprint", "--operation"]);
      const io = metadataServices ?? nativeMetadataServices();
      if (parsed["--operation"]) {
        if (verb !== "apply" || Object.keys(parsed).some(k => !["--operation", "--json"].includes(k))) throw Error();
        output = useOperationStatus(parsed["--operation"], io.store);
      } else {
        if (verb === "plan" && parsed["--fingerprint"]) throw Error();
        const request = { project: parsed["--project"] ?? process.cwd(), bindingId: parsed["--binding"], targetId: parsed["--target"] };
        const useIO: UseIO = { ...io, human: io.useHuman ?? { approve: async () => "unavailable" }, handoff: runGenericCloudflareDeployment };
        assertProFeature("deploy", useIO.licenseOptions);
        const selected = io.store.readCatalog()?.catalog.destinations.find(d => d.id === request.targetId);
        if (selected && selected.kind !== "cloudflare") {
          const hostedIO: HostedUseIO = { ...io, human: io.hostedUseHuman ?? { approve: async () => "unavailable" }, handoff: runGenericHostedDeployment };
          output = verb === "plan" ? projectHostedUsePlan(prepareHostedUse(request, hostedIO)) : await applyHostedUse(request, parsed["--fingerprint"] ?? "", hostedIO);
        } else output = verb === "plan" ? projectUsePlan(prepareUse(request, useIO)) : await applyUse(request, parsed["--fingerprint"] ?? "", useIO);
      }
    } else if (command === "profile" || command === "launch") {
      const verb = rest.shift();
      if (command === "profile" ? !["plan", "register", "list"].includes(verb ?? "") : verb !== "plan" && verb !== "apply") throw Error();
      const parsed = args(rest, command === "profile" && verb === "list" ? ["--project"] : command === "profile" ? ["--project", "--kind", "--runtime", "--entry", "--cwd", "--bindings", "--duration", "--profile", "--fingerprint", "--operation"] :
        ["--project", "--profile", "--fingerprint", "--operation"]);
      if (process.platform !== "win32") throw Error();
      const io = metadataServices ?? nativeMetadataServices();
      if (command === "profile" && verb === "list") {
        output = listProfiles(parsed["--project"] ?? process.cwd(), io);
      } else if (parsed["--operation"]) {
        if (verb === "plan" || Object.keys(parsed).some(k => !["--operation", "--json"].includes(k))) throw Error();
        output = command === "profile" ? recoverBinding(parsed["--operation"], io.store) : launchOperationStatus(parsed["--operation"], io.store);
      } else {
        if (verb === "plan" && parsed["--fingerprint"]) throw Error();
        if (command === "profile") {
          const request: ProfileRequest = { project: parsed["--project"] ?? process.cwd(), kind: parsed["--kind"] as ProfileRequest["kind"],
            runtime: parsed["--runtime"] ?? process.execPath, entry: parsed["--entry"], cwd: parsed["--cwd"] ?? ".",
            bindingIds: (parsed["--bindings"] ?? "").split(","), maxDurationSeconds: Number(parsed["--duration"] ?? "7200"),
            ...(parsed["--profile"] ? { profileId: parsed["--profile"] } : {}) };
          const profileIO = { store: io.store, human: io.profileHuman ?? { confirm: async () => "unavailable" as const } };
          output = verb === "plan" ? projectProfilePlan(prepareProfile(request, profileIO)) : await registerProfile(request, parsed["--fingerprint"] ?? "", profileIO);
        } else {
          const request = { project: parsed["--project"] ?? process.cwd(), profileId: parsed["--profile"] };
          const controller = new AbortController(), cancel = () => controller.abort();
          const launchIO: LaunchIO = { ...io, human: io.launchHuman ?? { approve: async () => "unavailable" }, handoff: runGenericLocalApplication, signal: controller.signal };
          process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
          try { output = verb === "plan" ? projectLaunchPlan(prepareLaunch(request, launchIO)) : await applyLaunch(request, parsed["--fingerprint"] ?? "", launchIO); }
          finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
        }
      }
    } else if (command === "operation" && rest[0] === "status") {
      const parsed = args(rest.slice(1), ["--operation"]);
      if (!parsed["--operation"] || !inputRequestSchema.safeParse({ operationId: parsed["--operation"] }).success) throw Error();
      const store = metadataServices?.store ?? new CatalogStore(), saved = store.readOperation(parsed["--operation"]);
      output = saved?.operation.kind === "local-launch" ? launchOperationStatus(parsed["--operation"], store) : saved && ["cloudflare-use", "vercel-use", "github-use"].includes(saved.operation.kind) ? useOperationStatus(parsed["--operation"], store) : saved ? { schemaVersion: 1, permission: "none", executed: false, status: "recorded", operationId: saved.operation.operationId,
        kind: saved.operation.kind, state: saved.operation.state, currentPresence: "not-inspected", replay: "not-permitted" } :
        { schemaVersion: 1, permission: "none", executed: false, status: "unknown", currentPresence: "not-inspected", replay: "not-permitted" };
    } else throw Error();
  } catch (error) {
    output = { schemaVersion: 1, permission: "none", executed: false, status: error instanceof ProFeatureError ? "pro-required" : "unavailable", reason: "invalid-request-or-metadata-unavailable" }; success = false;
  }
  // No raw exceptions or caller arguments can enter status output.
  console.log(JSON.stringify(output));
  return success ? 0 : 1;
}

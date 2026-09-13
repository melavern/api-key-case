import { upsertRegistryEntry } from "../vault/registry.js";
import { SecretStoreMetadataError, type SecretRef } from "../vault/types.js";
import type {
  HumanPlane,
  HumanSecretInputStatus,
  RemovalPlan,
  SecretInputRequest
} from "./types.js";
import { MacOSHumanPlane, resolveMacOSOsascript } from "./macos.js";
import { resolveWindowsPowerShell, WindowsHumanPlane } from "./windows.js";

class UnavailableHumanPlane implements HumanPlane {
  capability(): "handoff-only" {
    return "handoff-only";
  }

  async askSecret(_request: SecretInputRequest): Promise<"unavailable"> {
    return "unavailable";
  }

  async askApproval(_plan: import("../deploy/types.js").ApprovalPlan): Promise<"unavailable"> {
    return "unavailable";
  }

  async askRemoval(_plan: RemovalPlan): Promise<"unavailable"> {
    return "unavailable";
  }
}

// What this host would need for an Agent-independent decision to be possible
// at all. It is a static description of the platform requirement, not a probe:
// it never reports which specific verifier result was returned, so it cannot
// tell an agent whether a human cancelled, was absent, or is unenrolled.
export function humanPlaneRequirement(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return "Windows 11 build 22000 or later, with Windows Hello (PIN, fingerprint, or face) set up for this account";
  }
  if (platform === "darwin") {
    return "a macOS host with an interactive desktop session";
  }
  return (
    "Windows 11 build 22000 or later with Windows Hello set up, or a supported macOS host; " +
    "Linux is handoff-only"
  );
}

export function createHumanPlane(platform: NodeJS.Platform = process.platform): HumanPlane {
  if (platform === "win32") {
    return new WindowsHumanPlane(resolveWindowsPowerShell());
  }
  if (platform === "darwin") {
    return new MacOSHumanPlane(resolveMacOSOsascript());
  }
  return new UnavailableHumanPlane();
}

export async function askAndRecordSecret(
  humanPlane: HumanPlane,
  ref: SecretRef,
  projectPath: string | null,
  record: typeof upsertRegistryEntry = upsertRegistryEntry
): Promise<HumanSecretInputStatus> {
  const request: SecretInputRequest = { ...ref, projectDir: projectPath };
  const status = await humanPlane.askSecret(request);
  if (status === "saved") {
    try {
      record({
        name: ref.name,
        scope: ref.scope,
        projectId: ref.projectId,
        projectPath
      });
    } catch {
      throw new SecretStoreMetadataError();
    }
  }
  return status;
}

export * from "./types.js";
export * from "./macos.js";
export * from "./windows.js";

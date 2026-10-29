import type { SecretScope } from "../vault/types.js";

export type TargetId = "cloudflare" | "vercel" | "github";
export type DeployEnv = "production" | "preview" | "development";

/**
 * Why the human is being asked. `first-use` and `changed` describe a
 * destination whose class could be automatic once confirmed; `always-approve`
 * describes an operation that requires approval on every run no matter what
 * the destination trust store says.
 */
export type ApprovalTrustState = "first-use" | "changed" | "always-approve";

// Internal, single-call description of the operation shown by the
// Agent-independent Human Plane. It is never serialized or returned to the
// caller. It contains no approval credential and no Secret value.
export interface ApprovalPlan {
  readonly name: string;
  readonly scope: SecretScope;
  readonly projectId: string | null;
  readonly target: TargetId;
  readonly env: DeployEnv;
  readonly force: boolean;
  readonly projectDir: string;
  readonly destination: string;
  readonly cliPath: string;
  readonly command: string;
  readonly preCommands: readonly string[];
  readonly trustState: ApprovalTrustState;
  /** Present only for the closed environment-credential deployment route. */
  readonly connectionSource?: Readonly<{
    credentialVersion: 2;
    service: "resend" | "clerk" | "openai" | "stripe-test";
    operation?: "cloudflare-version-preparation";
    environment: DeployEnv;
    credentialRevision: string;
  }>;
}

export interface DeployPlan {
  argv: string[]; // argv[0] = CLI command name ("wrangler", etc). Never contains a secret value.
  valueVia: "stdin";
  displayCommand: string;
  overwriteWarning: boolean;
  preSteps?: DeployPlan[];
}

export interface DetectResult {
  detected: boolean;
  reason: string;
}

export interface CliStatus {
  installed: boolean;
  version?: string;
  loggedIn: boolean;
  /** Closed, non-credential provider account identity for approval binding. */
  identity?: string;
  hint?: string;
}

export interface CliCheckOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly pathOverride?: string;
  readonly resolvedCli?: import("./which.js").ResolvedCli;
}

export interface DeployTarget {
  readonly id: TargetId;
  readonly cliCommand: string;
  detect(projectDir: string): Promise<DetectResult>;
  checkCli(options?: CliCheckOptions): Promise<CliStatus>;
  planDeploy(name: string, env: DeployEnv, opts: { force: boolean }): DeployPlan;
  manualSteps(name: string, env: DeployEnv): string[];
}

export const DEPLOY_ENVS: readonly DeployEnv[] = Object.freeze([
  "production",
  "preview",
  "development"
]);

export function isDeployEnv(value: string): value is DeployEnv {
  return (DEPLOY_ENVS as readonly string[]).includes(value);
}

/** Native builders reject non-closed or mismatched v2 source display data. */
export function assertApprovalConnectionSource(plan: ApprovalPlan): void {
  if (plan.connectionSource === undefined) return;
  const source = plan.connectionSource;
  if (!source || typeof source !== "object" || Array.isArray(source) ||
      Object.keys(source).sort().join(",") !== (source.service === "clerk" ? "credentialRevision,credentialVersion,environment,operation,service" : "credentialRevision,credentialVersion,environment,service") ||
      source.credentialVersion !== 2 ||
      !((source.service === "resend" && plan.name === "RESEND_API_KEY") ||
        (source.service === "openai" && plan.name === "OPENAI_API_KEY" && ["vercel", "cloudflare"].includes(plan.target)) ||
        (source.service === "stripe-test" && plan.name === "STRIPE_API_KEY" && ["development", "preview"].includes(plan.env) && ["vercel", "cloudflare"].includes(plan.target)) ||
        (source.service === "clerk" && plan.name === "CLERK_SECRET_KEY" && plan.target === "cloudflare" && source.operation === "cloudflare-version-preparation")) || source.environment !== plan.env ||
      !isDeployEnv(source.environment) || plan.scope !== "project" ||
      !["vercel", "cloudflare", "github"].includes(plan.target) ||
      typeof source.credentialRevision !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(source.credentialRevision) ||
      (!Number.isFinite(Date.parse(source.credentialRevision)) || new Date(source.credentialRevision).toISOString() !== source.credentialRevision)) throw new Error("Invalid connection approval source.");
}

/** Closed source label shared by native approval builders. */
export function approvalSourceLabel(service: NonNullable<ApprovalPlan["connectionSource"]>["service"]): string {
  return service === "resend" ? "Resend" : service === "clerk" ? "Clerk" : service === "openai" ? "OpenAI" : "Stripe test (provider mode: test)";
}

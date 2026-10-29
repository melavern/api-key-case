/** New hosted sources need their own Windows acceptance. Not an input or setting. */
export const PROVIDER_HOSTED_NATIVE_ACCEPTED = false;
/** Windows registered-config route accepted separately; see CLOUDFLARE_TARGET_WINDOWS_VERIFICATION.md. */
export const CLOUDFLARE_TARGET_NATIVE_ACCEPTED = true;

export type HostedDeployService = "resend" | "openai" | "stripe-test";
export function isHostedDeployService(value: unknown): value is HostedDeployService {
  return value === "resend" || value === "openai" || value === "stripe-test";
}

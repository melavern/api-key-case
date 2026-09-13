/**
 * PostHog configuration for the CLI distribution.
 *
 * The project token used by the Capture API is intentionally a public
 * ingestion credential. Personal API keys and project secret API keys must
 * never be placed here. The configured value below is the existing shared
 * project's public ingestion token, which is safe to ship with the package.
 */

export const POSTHOG_PROJECT_TOKEN_ENV = "API_KEY_CASE_POSTHOG_PROJECT_TOKEN";

export const POSTHOG_PUBLIC_API_HOSTS = {
  us: "https://us.i.posthog.com",
  eu: "https://eu.i.posthog.com"
} as const;

export type PostHogApiHost = (typeof POSTHOG_PUBLIC_API_HOSTS)[keyof typeof POSTHOG_PUBLIC_API_HOSTS];

export const POSTHOG_PUBLIC_API_HOST: PostHogApiHost = POSTHOG_PUBLIC_API_HOSTS.us;
export const POSTHOG_PUBLIC_PROJECT_TOKEN = "phc_ywKixxtebFdnFQLkrgf9swszumg9ZNN9x8Wy8NoDs4as";

export const POSTHOG_CAPTURE_ENDPOINTS: Readonly<Record<PostHogApiHost, string>> = {
  [POSTHOG_PUBLIC_API_HOSTS.us]: `${POSTHOG_PUBLIC_API_HOSTS.us}/i/v0/e/`,
  [POSTHOG_PUBLIC_API_HOSTS.eu]: `${POSTHOG_PUBLIC_API_HOSTS.eu}/i/v0/e/`
};

export type PublicPostHogConfig = Readonly<{
  projectToken: string;
  apiHost: PostHogApiHost;
}>;

/**
 * Release-time configuration. The public project token is bundled so npm
 * users do not need an environment variable; the environment remains an
 * override for development and tests.
 */
export const POSTHOG_PUBLIC_CONFIG: PublicPostHogConfig = {
  projectToken: POSTHOG_PUBLIC_PROJECT_TOKEN,
  apiHost: POSTHOG_PUBLIC_API_HOST
};

export type ResolvedPostHogConfig = Readonly<{
  projectToken: string;
  endpoint: string;
  source: "environment" | "public";
}>;

type Environment = Readonly<Record<string, string | undefined>>;
const PRIVATE_CREDENTIAL_PREFIXES = ["phx_", "phs_"] as const;
const PROJECT_TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]{8,256}$/;

/**
 * Resolve the production public token, with a non-empty environment value
 * taking precedence for development, tests, and local overrides.
 *
 * The endpoint is derived only from the fixed US/EU allowlist. There is no
 * arbitrary endpoint input in the production CLI path.
 */
export function resolvePostHogConfig(
  environment: Environment = process.env,
  publicConfig: PublicPostHogConfig = POSTHOG_PUBLIC_CONFIG
): ResolvedPostHogConfig | null {
  const environmentToken = normalizeToken(environment[POSTHOG_PROJECT_TOKEN_ENV]);
  const publicToken = normalizeToken(publicConfig.projectToken);
  const token = environmentToken ?? publicToken;
  const endpoint = POSTHOG_CAPTURE_ENDPOINTS[publicConfig.apiHost];

  if (!token || !endpoint) {
    return null;
  }

  return {
    projectToken: token,
    endpoint,
    source: environmentToken ? "environment" : "public"
  };
}

function normalizeToken(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const token = value.trim();
  if (
    !PROJECT_TOKEN_PATTERN.test(token) ||
    PRIVATE_CREDENTIAL_PREFIXES.some((prefix) => token.startsWith(prefix))
  ) {
    return undefined;
  }
  return token;
}

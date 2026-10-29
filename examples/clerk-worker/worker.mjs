import { createClerkClient } from '@clerk/backend';

// Ordinary Cloudflare Worker bindings. API Key Case places only CLERK_SECRET_KEY.
// The public key and application origin belong to the selected app environment.
const reply = (status, result) => Response.json({ result }, {
  status, headers: { 'Cache-Control': 'no-store' },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/private') return reply(404, 'not-found');
    if (request.method !== 'GET') return reply(405, 'method-not-allowed');
    // API endpoint: an existing signed-in frontend supplies its session token.
    // Do not accept a caller's user ID, decoded claims, or client-side success flag.
    if (!/^Bearer [^\s]+$/.test(request.headers.get('Authorization') ?? '')) {
      return reply(401, 'sign-in-required');
    }
    try {
      const origin = new URL(env.APP_ORIGIN);
      if (origin.protocol !== 'https:' || origin.origin !== env.APP_ORIGIN ||
          typeof env.CLERK_SECRET_KEY !== 'string' || !env.CLERK_SECRET_KEY ||
          typeof env.CLERK_PUBLISHABLE_KEY !== 'string' || !env.CLERK_PUBLISHABLE_KEY) {
        return reply(503, 'configuration-unavailable');
      }
      const clerk = createClerkClient({
        secretKey: env.CLERK_SECRET_KEY,
        publishableKey: env.CLERK_PUBLISHABLE_KEY,
        telemetry: { disabled: true },
      });
      const state = await clerk.authenticateRequest(request, {
        acceptsToken: 'session_token', authorizedParties: [origin.origin],
      });
      if (!state.isAuthenticated || state.tokenType !== 'session_token') {
        return reply(401, 'sign-in-required');
      }
      // This endpoint requires an origin-bound session, including when azp is absent.
      // Inspect only the claims returned after the SDK has verified the signature.
      const auth = state.toAuth();
      if (!auth.userId || auth.sessionClaims?.azp !== origin.origin) {
        return reply(401, 'sign-in-required');
      }
      // A deliberately small protected feature; return no token, user record or key.
      return reply(200, 'protected-feature-accessible');
    } catch {
      return reply(503, 'authentication-unavailable');
    }
  },
};

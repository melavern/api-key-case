// Set only after the exact vNext Windows synthetic native input/fault acceptance.
// Legacy input acceptance and a helper's existence do not satisfy this gate.
export const VNEXT_WINDOWS_REGISTRATION_ACCEPTED = true;

// Binding selection/relink needs its own native metadata-only acceptance.
export const VNEXT_WINDOWS_BINDING_ACCEPTED = true;

// Generic value use needs its own exact native acceptance, including OS verification.
// 2026-10-21: two fresh Windows verifications, dedicated OS slots and offline Wrangler.
export const VNEXT_WINDOWS_CLOUDFLARE_ACCEPTED = true;

// Ordinary editable Node/npm/Python applications require independent owner acceptance.
// 2026-10-21: Node entry/npm/Python OS-slot handoff with three fresh Windows verifications.
export const VNEXT_WINDOWS_LOCAL_ACCEPTED = true;

// Each new provider route needs its own exact Windows OS-slot/fixed-CLI acceptance.
// 2026-10-22 JST: Vercel in the paired native run; GitHub in its own fresh native run.
export const VNEXT_WINDOWS_VERCEL_ACCEPTED = true;
export const VNEXT_WINDOWS_GITHUB_ACCEPTED = true;

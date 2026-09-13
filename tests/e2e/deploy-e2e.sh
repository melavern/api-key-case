#!/usr/bin/env bash
# End-to-end verification of one deploy target against the real service.
#
# Flow, per platform: create a throwaway resource -> save a canary into the
# real OS secret store through a pty -> `api-key-case deploy` -> read the
# secret list back from the service -> assert the value never appeared in any
# output -> delete everything.
#
# This exercises the shipped code paths only. It adds no test-only flag to the
# CLI: the TTY requirement on `save` and on the production confirmation is a
# product guarantee (AGENTS.md section 3), so the harness types into a pty
# instead of weakening it.
#
# Usage: tests/e2e/deploy-e2e.sh <cloudflare|vercel|github>
set -euo pipefail

PLATFORM="${1:-}"
case "$PLATFORM" in
  cloudflare | vercel | github) ;;
  *)
    echo "Usage: $0 <cloudflare|vercel|github>" >&2
    exit 2
    ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$REPO_ROOT/dist/cli/index.js"
SECRET_NAME="AKC_E2E_CANARY"

# Which OS store, and which pseudo-terminal, are we exercising? Windows runs
# this script under Git Bash, where `uname -s` reports MINGW64_NT-*.
case "$(uname -s)" in
  Darwin)   HOST_OS="macos" ;;
  Linux)    HOST_OS="linux" ;;
  MINGW* | MSYS* | CYGWIN*) HOST_OS="windows" ;;
  *) echo "Unsupported host: $(uname -s)" >&2; exit 2 ;;
esac

# Both drivers take the same arguments; they differ only in how they get a
# real terminal. POSIX uses a pty, Windows uses ConPTY through node-pty,
# because the product requires a TTY and must not gain a bypass for tests.
if [ "$HOST_OS" = "windows" ]; then
  pty_drive() { node "$REPO_ROOT/tests/e2e/pty-drive.mjs" "$@"; }
else
  pty_drive() { python3 "$REPO_ROOT/tests/e2e/pty-drive.py" "$@"; }
fi

RUN_ID="${AKC_E2E_RUN_ID:?AKC_E2E_RUN_ID is required (a unique suffix for throwaway resources)}"
CANARY="${AKC_E2E_CANARY_VALUE:?AKC_E2E_CANARY_VALUE is required (the throwaway secret value)}"
RESOURCE="akc-e2e-${RUN_ID}-${PLATFORM}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/akc-e2e-XXXXXX")"
LOGS="$WORK/logs"       # printed to the job log; the pty driver masks these
RAW="$WORK/raw"         # unmasked pty output, for the leak check ONLY — never printed
FIXTURE="$WORK/fixture"
mkdir -p "$LOGS" "$RAW" "$FIXTURE"
chmod 700 "$RAW"

# Per-platform env: which deploy env to use, and whether the CLI will demand a
# typed "yes" (production always does; github always does regardless of --env,
# see packages/core/deploy/engine.ts).
case "$PLATFORM" in
  cloudflare) DEPLOY_ENV="production"; CONFIRMS=1 ;;
  vercel)     DEPLOY_ENV="development"; CONFIRMS=0 ;;
  github)     DEPLOY_ENV="development"; CONFIRMS=1 ;;
esac

step()  { printf '\n=== %s\n' "$*"; }
ok()    { printf 'PASS  %s\n' "$*"; }
fail()  { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

require_env() {
  local missing=0
  for name in "$@"; do
    if [ -z "${!name:-}" ]; then
      echo "Missing required secret/env: $name" >&2
      missing=1
    fi
  done
  [ "$missing" -eq 0 ] || fail "required credentials are not configured"
}

# ---------------------------------------------------------------------------
# Cleanup. Registered before anything is created, so a failure half-way still
# tears down whatever exists. Every command is best-effort and reads from
# /dev/null so that an unexpected prompt aborts instead of hanging.
# ---------------------------------------------------------------------------
# Leaving a stray Worker, project or repo behind in someone's real account is
# worse than a failed test, so each teardown runs the CLI the user would run
# AND then a direct API delete, and finally asserts the resource is gone.
# Only HTTP status codes are printed, never response bodies.
http_status() {
  curl -sS -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || echo "000"
}

cleanup() {
  local status=$?
  set +e
  step "cleanup ($PLATFORM)"

  case "$PLATFORM" in
    cloudflare)
      local cf_api="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID:-}/workers/scripts/$RESOURCE"
      (cd "$FIXTURE" && wrangler secret delete "$SECRET_NAME" --name "$RESOURCE" </dev/null) 2>&1 | tail -3
      (cd "$FIXTURE" && wrangler delete "$RESOURCE" --force </dev/null) 2>&1 | tail -3
      http_status -X DELETE "$cf_api" -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN:-}" >/dev/null
      local left
      left="$(http_status "$cf_api" -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN:-}")"
      if [ "$left" = "404" ]; then
        echo "cloudflare: worker $RESOURCE is gone (GET -> 404)"
      else
        echo "::warning::cloudflare worker $RESOURCE may still exist (GET -> $left); check the dashboard"
      fi
      ;;

    vercel)
      local v_api="https://api.vercel.com/v9/projects/$RESOURCE"
      (cd "$FIXTURE" && vercel env rm "$SECRET_NAME" "$DEPLOY_ENV" --yes </dev/null) 2>&1 | tail -3
      # `vercel project rm` has no documented --yes, so the API delete below is
      # the one that is actually relied on.
      http_status -X DELETE "$v_api" -H "Authorization: Bearer ${VERCEL_TOKEN:-}" >/dev/null
      local left
      left="$(http_status "$v_api" -H "Authorization: Bearer ${VERCEL_TOKEN:-}")"
      if [ "$left" = "404" ]; then
        echo "vercel: project $RESOURCE is gone (GET -> 404)"
      else
        echo "::warning::vercel project $RESOURCE may still exist (GET -> $left); check the dashboard"
      fi
      ;;

    github)
      local slug="${GH_OWNER:-}/$RESOURCE"
      gh secret delete "$SECRET_NAME" --repo "$slug" </dev/null 2>&1 | tail -3
      gh repo delete "$slug" --yes </dev/null 2>&1 | tail -3
      if gh repo view "$slug" >/dev/null 2>&1; then
        echo "::warning::github repo $slug may still exist; check https://github.com/$slug"
      else
        echo "github: repo $slug is gone (gh repo view fails)"
      fi
      ;;
  esac

  # Always clear the local vault entry, whatever happened above. Since Phase 6E
  # `api-key-case remove` is a Human Plane decision with no unattended path, so
  # this harness calls the vault module directly instead of trying to bypass
  # that boundary from a script.
  node -e '
    const [entry, name, dir] = process.argv.slice(1);
    import(entry).then(async (vault) => {
      const store = vault.createVault();
      if (!(await store.isAvailable())) return;
      const removed = await vault.removeSecret(store, {
        name,
        scope: "project",
        projectId: vault.deriveProjectId(dir)
      });
      console.log(removed ? `cleared ${name} from the local vault` : `${name} was not registered`);
    });
  ' "file://$REPO_ROOT/dist/core/vault/index.js" "$SECRET_NAME" "$FIXTURE" 2>&1 | tail -2
  rm -rf "$WORK"

  if [ "$status" -eq 0 ]; then
    printf '\n=== RESULT: %s e2e PASSED\n' "$PLATFORM"
  else
    printf '\n=== RESULT: %s e2e FAILED (exit %s)\n' "$PLATFORM" "$status"
  fi
  exit "$status"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 0. Preflight
# ---------------------------------------------------------------------------
step "preflight"
[ -f "$CLI" ] || fail "dist/cli/index.js is missing; run npm run build first"
[ -f "$HOME/.api-key-case/license.key" ] || fail "no Pro license installed; deploy is gated (exit 6)"

node "$CLI" license status | tee "$LOGS/license.txt"
grep -q '^plan: pro' "$LOGS/license.txt" || fail "license did not verify as pro"
ok "Pro license verified offline by the shipped CLI"

# ---------------------------------------------------------------------------
# 1. Create the throwaway resource on the real service
# ---------------------------------------------------------------------------
step "provision throwaway resource on $PLATFORM"
case "$PLATFORM" in
  cloudflare)
    require_env CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
    mkdir -p "$FIXTURE/src"
    cat > "$FIXTURE/src/index.js" <<'JS'
export default {
  fetch() {
    return new Response("api-key-case e2e canary worker");
  }
};
JS
    # workers_dev = false keeps this throwaway Worker off any public hostname.
    cat > "$FIXTURE/wrangler.toml" <<TOML
name = "$RESOURCE"
main = "src/index.js"
compatibility_date = "2026-01-01"
workers_dev = false
TOML
    (cd "$FIXTURE" && wrangler deploy) 2>&1 | tail -10
    ok "worker $RESOURCE deployed"
    ;;

  vercel)
    require_env VERCEL_TOKEN
    printf '{}\n' > "$FIXTURE/vercel.json"
    vercel project add "$RESOURCE" 2>&1 | tail -5
    (cd "$FIXTURE" && vercel link --yes --project "$RESOURCE") 2>&1 | tail -5
    [ -f "$FIXTURE/.vercel/project.json" ] || fail "vercel link did not produce .vercel/project.json"
    ok "project $RESOURCE created and linked"
    ;;

  github)
    require_env GH_TOKEN GH_OWNER
    gh repo create "$GH_OWNER/$RESOURCE" --private --add-readme 2>&1 | tail -5
    # gh repo clone (not git clone) so the private repo authenticates with the
    # same token the adapter will use, and origin is a github.com URL that
    # GitHubAdapter.detect() recognises.
    gh repo clone "$GH_OWNER/$RESOURCE" "$FIXTURE/repo" -- --depth 1 2>&1 | tail -3
    FIXTURE="$FIXTURE/repo"
    ok "repo $GH_OWNER/$RESOURCE created and cloned"
    ;;
esac

cd "$FIXTURE"

# ---------------------------------------------------------------------------
# 2. api-key-case targets — the adapter must see the CLI as installed + logged in
# ---------------------------------------------------------------------------
step "api-key-case targets"
node "$CLI" targets --json | tee "$LOGS/targets.json"
node -e '
const [platform, path] = process.argv.slice(1);
const data = JSON.parse(require("fs").readFileSync(path, "utf8"));
const entry = data.targets.find((t) => t.id === platform);
const problems = [];
if (!entry.detected) problems.push(`not detected (${entry.detectReason})`);
if (!entry.cliInstalled) problems.push("cli not installed");
if (!entry.loggedIn) problems.push(`cli not logged in (hint: ${entry.hint})`);
if (problems.length) {
  console.error("FAIL  targets: " + problems.join("; "));
  process.exit(1);
}
console.log(`PASS  targets: ${platform} detected, cli ${entry.cliVersion}, logged in`);
' "$PLATFORM" "$LOGS/targets.json"

# ---------------------------------------------------------------------------
# 3. Save the canary into the real OS secret store (macOS Keychain) via a pty
# ---------------------------------------------------------------------------
step "api-key-case save (real OS secret store, hidden input over a pty)"
pty_drive \
  --step "Enter value for=>env:AKC_E2E_CANARY_VALUE" \
  --mask-env AKC_E2E_CANARY_VALUE \
  --transcript "$LOGS/save.txt" \
  --raw-transcript "$RAW/save.raw" \
  -- node "$CLI" save "$SECRET_NAME" --scope project
ok "save reported success"

node "$CLI" check "$SECRET_NAME" --scope project --json --strict | tee "$LOGS/check.json"
grep -q '"status": "registered"' "$LOGS/check.json" || fail "check does not report the canary as registered"
grep -q '"backend": "' "$LOGS/check.json" || fail "check did not report a backend"
node -e '
const data = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
if (data.backend.toLowerCase().includes("memory")) {
  console.error(`FAIL  vault fell back to an in-memory backend (${data.backend}); the real OS store was not used`);
  process.exit(1);
}
console.log(`PASS  stored in real OS secret store: backend=${data.backend}`);
' "$LOGS/check.json"

# Independent confirmation from outside the product: the item really is in the
# OS store. Both tools below print metadata only and are never asked for the
# value (`security` without -w, `secret-tool search` rather than `lookup`).
ACCOUNT="$(node -e '
const data = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
process.stdout.write(`v1|project|${data.projectId}|${process.argv[2]}`);
' "$LOGS/check.json" "$SECRET_NAME")"

case "$HOST_OS" in
  macos)
    security find-generic-password -s "api-key-case" -a "$ACCOUNT" > "$LOGS/store.txt" 2>&1 \
      || fail "the item is not present in the macOS login Keychain"
    grep -q 'acct"<blob>="v1|project|' "$LOGS/store.txt" || fail "unexpected Keychain item shape"
    ok "macOS Keychain confirms the item independently of api-key-case"
    ;;

  linux)
    # `secret-tool search` prints the stored value as part of its output, so
    # its stdout is only ever piped into grep -- never displayed, never
    # written to a file. The diagnostic below filters with an allowlist
    # (`label`/`attributes.*` lines only) rather than by excluding the secret
    # line, so it cannot print a value even if the output format changes.
    #
    # keyring-rs has moved its Secret Service backend between crates across
    # versions and the attribute names came with it, so try the known
    # spellings and require one to find the account.
    found=""
    for attr in service application target; do
      if secret-tool search --all "$attr" "api-key-case" 2>/dev/null | grep -qF "$ACCOUNT"; then
        found="$attr"
        break
      fi
    done
    if [ -z "$found" ]; then
      echo "--- Secret Service contents (labels and attributes only) ---" >&2
      for attr in service application target; do
        echo "[searched by: $attr]" >&2
        secret-tool search --all "$attr" "api-key-case" 2>/dev/null \
          | grep -E '^(label|attributes\.)' >&2 || true
      done
      fail "the item was not found in the Secret Service under any known attribute name"
    fi
    ok "libsecret confirms the item independently of api-key-case (attribute: $found)"
    ;;

  windows)
    # `cmdkey /list` enumerates Credential Manager targets and never prints a
    # password, so unlike secret-tool its output is safe to keep and show.
    # keyring-rs stores generic credentials as "{account}.{service}", verified
    # against a real Credential Manager.
    #
    # `//list`, not `/list`: this runs under Git Bash, where MSYS rewrites an
    # argument that looks like an absolute path into a Windows path, and
    # cmdkey then rejects it as a bad parameter. `//list` is the MSYS escape
    # that arrives as `/list`.
    cmdkey //list > "$LOGS/store.txt" 2>&1 || true

    # Distinguish "cmdkey did not run" from "the credential is missing" —
    # otherwise a tooling failure reads as a product defect. Every populated
    # listing has at least one "Target:" line, in any UI language.
    if ! grep -q "Target:" "$LOGS/store.txt"; then
      echo "--- cmdkey output ---" >&2
      cat "$LOGS/store.txt" >&2
      fail "cmdkey listed no credentials at all; the check itself did not run"
    fi

    if ! grep -qF "$ACCOUNT.api-key-case" "$LOGS/store.txt"; then
      echo "--- Credential Manager targets mentioning api-key-case ---" >&2
      grep -F "api-key-case" "$LOGS/store.txt" >&2 || echo "(none)" >&2
      fail "the item is not present in Windows Credential Manager"
    fi
    ok "Windows Credential Manager confirms the item independently of api-key-case"
    ;;
esac

# ---------------------------------------------------------------------------
# 4. dry-run first: prove the plan is correct without touching the service
# ---------------------------------------------------------------------------
step "api-key-case deploy --dry-run"
node "$CLI" deploy "$SECRET_NAME" --target "$PLATFORM" --env "$DEPLOY_ENV" --scope project --dry-run \
  | tee "$LOGS/dry-run.txt"
grep -q "target : $PLATFORM" "$LOGS/dry-run.txt" || fail "dry-run plan did not name the target"
grep -q "env    : $DEPLOY_ENV" "$LOGS/dry-run.txt" || fail "dry-run plan did not name the env"
ok "dry-run printed the plan and changed nothing"

# ---------------------------------------------------------------------------
# 5. Confirmation is real: answering anything but "yes" must abort with exit 4
# ---------------------------------------------------------------------------
if [ "$CONFIRMS" -eq 1 ]; then
  step "confirmation guard (answering 'no' must abort)"
  set +e
  pty_drive \
    --step "Type 'yes'=>literal:no" \
    --mask-env AKC_E2E_CANARY_VALUE \
    --transcript "$LOGS/declined.txt" \
    -- node "$CLI" deploy "$SECRET_NAME" --target "$PLATFORM" --env "$DEPLOY_ENV" --scope project
  declined_status=$?
  set -e
  [ "$declined_status" -eq 4 ] || fail "declining the confirmation exited $declined_status, expected 4"
  grep -q "Aborted: production confirmation was not given" "$LOGS/declined.txt" \
    || fail "no abort message after declining"
  ok "a non-'yes' answer aborts with exit 4 and deploys nothing"
fi

# ---------------------------------------------------------------------------
# 6. The real deploy
# ---------------------------------------------------------------------------
step "api-key-case deploy (real)"
DEPLOY_STEPS=(--mask-env AKC_E2E_CANARY_VALUE --transcript "$LOGS/deploy.txt" --raw-transcript "$RAW/deploy.raw")
if [ "$CONFIRMS" -eq 1 ]; then
  DEPLOY_STEPS=(--step "Type 'yes'=>literal:yes" "${DEPLOY_STEPS[@]}")
fi
pty_drive "${DEPLOY_STEPS[@]}" \
  -- node "$CLI" deploy "$SECRET_NAME" --target "$PLATFORM" --env "$DEPLOY_ENV" --scope project
grep -q "OK: $SECRET_NAME deployed to $PLATFORM" "$LOGS/deploy.txt" \
  || fail "deploy did not report success"
ok "deploy reported OK"

# ---------------------------------------------------------------------------
# 7. Read it back from the service itself
# ---------------------------------------------------------------------------
step "confirm registration on the real $PLATFORM service"
case "$PLATFORM" in
  cloudflare)
    wrangler secret list --name "$RESOURCE" | tee "$LOGS/verify.txt"
    ;;
  vercel)
    vercel env ls "$DEPLOY_ENV" | tee "$LOGS/verify.txt"
    ;;
  github)
    gh api "repos/$GH_OWNER/$RESOURCE/actions/secrets" --jq '.secrets[].name' | tee "$LOGS/verify.txt"
    ;;
esac
grep -q "$SECRET_NAME" "$LOGS/verify.txt" \
  || fail "$PLATFORM does not list $SECRET_NAME after deploy"
ok "$PLATFORM lists $SECRET_NAME — the value really landed on the service"

# ---------------------------------------------------------------------------
# 8. The security boundary: the value must appear in none of this
# ---------------------------------------------------------------------------
step "leak check"
# $RAW holds the UNMASKED pty output, so this genuinely tests the product's
# own redaction (packages/core/deploy/handoff.ts scrub()) rather than the
# harness's mask. Only file names are ever printed, never a matching line.
if grep -rqF "$CANARY" "$LOGS" "$RAW"; then
  grep -rlF "$CANARY" "$LOGS" "$RAW" >&2
  fail "the secret value appeared in captured output"
fi

# A terminal can hard-wrap a long line, which would split a leaked value
# across a newline and hide it from the plain grep above. Re-check with all
# whitespace removed from both sides so a wrapped leak still trips this.
FLAT_CANARY="$(printf '%s' "$CANARY" | tr -d '[:space:]')"
for file in "$LOGS"/* "$RAW"/*; do
  [ -f "$file" ] || continue
  if tr -d '[:space:]' < "$file" | grep -qF "$FLAT_CANARY"; then
    echo "$file" >&2
    fail "the secret value appeared in captured output (split across lines)"
  fi
done
ok "the canary value appears in no transcript, plan, or service listing"

if grep -rqF "$CANARY" "$FIXTURE" 2>/dev/null; then
  grep -rlF "$CANARY" "$FIXTURE" >&2
  fail "the secret value was written into the project directory"
fi
ok "the canary value was written to no file in the project directory"

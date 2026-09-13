# Phase 6 設計調査 — Agent-first UX（実装前・技術設計）

> **過去の調査:** 本書の「現状」は2026-08-29の調査対象を指す。後続のPhase A–E実装、Windows本人確認、
> schema 2 readinessを含まない。未実装の提案や旧stdin承認を現行仕様として採用しない。
> 現行の進行契約は[agent-setup-readiness.md](agent-setup-readiness.md)、残る受入は[RELEASING](../RELEASING.md)を参照する。

> 本書は設計調査であり、実装指示ではない。`AGENTS.md` の下位文書。矛盾したら `AGENTS.md` §3（セキュリティ境界）が常に勝つ。
> 調査日: 2026-08-29 / 対象コード: v0.9.1（`packages/{cli,core,adapters,mcp}`）

---

## 0. 何を実体として読んだか

| 領域 | 読んだ実体 | 現状の要点 |
|---|---|---|
| CLI | `packages/cli/index.ts`, `prompt.ts` | 10コマンド。`save` は TTY 必須・argv 拒否。`--json` は scan/check/list/targets/license status のみ |
| 値入力 | `prompt.ts:promptSecretValue` | `stdin.isTTY` 必須 → raw mode → echo off → keyring |
| 承認 | `prompt.ts:confirmExact` | `stdin.isTTY` 必須、厳密に `yes` のみ。非TTYは常に false |
| vault | `core/vault/{index,keyring,naming,registry}.ts` | 値を返すメソッドが interface に存在しない。`~/.api-key-case/index.json` はメタのみ |
| deploy | `core/deploy/{engine,handoff}.ts` | 値の読み出しは `handoff.ts` 1箇所。stdin 渡し・出力スクラブ・PATH解決限定 |
| 承認分岐 | `engine.ts:84` | `env==="production" \|\| adapter.id==="github"` で `confirmProduction` |
| MCP | `packages/mcp/{server,tools,messages}.ts` | 7ツール。値パラメータ不在。production/github は `action_required` を返して実行しない。`confirmProduction` は常に false 固定 |
| agent向け生成物 | `core/scanner.ts:307-419` | `AGENT_CONTEXT.safe.md` / `AI_SAFE_PROMPT.md`。**「API Key Case の使い方」ではなく「実装時の禁止事項」しか書いていない** |
| 検証 | `tests/e2e/pty-drive.{mjs,py}`, `docs/VERIFICATION.md` | 親プロセスが pty を握れば、値の打鍵も `yes` の打鍵も代行できることを自ら実証している |

---

## 1. 現状との差分（固定UXとの距離）

固定したUX（人間の作業は3つだけ）に対する現状。

| 固定UX | 現状 | 差分の性質 |
|---|---|---|
| 1回だけ bootstrap prompt を貼る | **導線が存在しない。** agent-report は「実装時の制約」を書くだけで、API Key Case を使う手順を agent に教えない。MCP を使うなら `claude mcp add` / `mcp.json` 手編集が必要 | 機能欠落 |
| Secret値だけ人間が入力 | `save` は人間が**自分のターミナル**でコマンド名を知って実行する必要がある。agent 側からは `action_required` の文字列が返るだけ | UX欠落（安全側に倒している） |
| 高リスク操作だけ Yes/No | CLI 直叩きなら `confirmExact` は **stdin** を読む。stdin を握る親（= agent）は `yes` を代筆できる | **セキュリティ欠落**（§2-B） |
| 導入・判断・検出・確認・追加削除・deploy は agent 側が自律 | 部品はすべて存在（scan/check/list/targets/deploy/license）だが、**「今この状況で何をすべきか」を返す単一の入口がない**。agent がコマンド体系を知っている前提 | 統合欠落 |

差分は3つに分解できる。

- **D1 配線がない**（AC-1 / AC-2 / AC-5）: agent に API Key Case の存在と使い方を届ける経路が無い。
- **D2 判断材料が分散している**（AC-3 / AC-6）: scan・check・targets・license を agent が自分で組み合わせないと「次にやること」が出ない。`list` / `remove` は MCP 非公開（`phase-4-mcp.md` §1.2 で意図的に除外）。
- **D3 人間面（Human Plane）が「人間の自前ターミナル」しかない**（AC-3 / AC-4）: agent 主導フローに接続できる人間入力・人間承認の面が存在しない。そして現在の TTY チェックは、agent が pty を握れる host では **人間性の証明になっていない**。

---

## 2. 重点検証（依頼された2点）

### 2-A. 「Agentが起動したプロセスへ人間がSecretを入力したとき、本当にAgentから値が見えないのか」

**結論: 見える。安全ではない。** 親が子の stdio を所有する以上、原理的に防げない。

このリポジトリ自身が反証を持っている。`docs/VERIFICATION.md:111` にこう書かれている。

> A terminal echoes typed input straight back. A human never hits that window because `readHiddenLine()` turns echo off first, but the harness answers within microseconds and does. Leaving it on made the first real run (32129207315) fail the leak check on all three platforms **against a value the harness had typed, not one the product printed.**

つまり `tests/e2e/pty-drive.*`（親プロセス）は、**pty 越しに打鍵された値をトランスクリプトとして完全に観測できていた**。`readHiddenLine()` の echo off は「端末が画面へ echo し返すこと」を止めるだけで、**pty master を握っている親からの可視性は一切下げない**。エコーが消えても、親は自分が write した内容を当然知っているし、人間が打つ場合はその keystroke が master 側に流れる。

そして、これは理論上の脅威ではなく **現に agent host が持っている機能**である。

- **Codex**: `exec_command` は `tty=true` で本物の PTY を割り当て、`write_stdin` で稼働中セッションへ打鍵できる。非TTYセッションでは `"stdin is closed for this session; rerun exec_command with tty=true to keep stdin open"` というエラーが出る（[openai/codex#18578](https://github.com/openai/codex/issues/18578)）。すなわち **agent 自身が pty-drive.mjs 相当の能力を標準ツールとして持つ**。
- **Claude Code**: 本セッションの Bash tool 内で実測 → `process.stdin.isTTY = undefined`（stdout/stderr も同じ）。**現時点では pty を与えていない**。ただしこれは harness の実装であって製品保証ではない。
- **Cursor**: agent terminal は非対話（PTY を使い回す実装）と報告されており、人間がそこへ打つ設計にはなっていない。

したがって導出される規則は1つ。

> **人間が値を打つ面は、agent の子孫プロセスの stdio であってはならない。**
> 安全なのは (a) agent が起動していない人間自身のターミナル、(b) キーストロークが window server 経由で届く GUI ダイアログ、の2つだけ。
> そして (b) の場合でも、**値をパイプで親へ返してはいけない**。ダイアログプロセスが自分で keyring へ書き、親には `OK/NG` だけを返す形にする必要がある。

残余リスク（正直に書く）: 同一 OS ユーザーである以上、ptrace / DLL injection / PATH すり替え / キーロガーは防げない。これは `SECURITY.md` の "The OS secret store is only as strong as the OS account" と同じ境界であり、新たに弱めるものではない。守っている対象は **「値が LLM のコンテキスト・トランスクリプト・ツール出力に入ること」** であって、悪意ある任意ローカルコードではない。この区別を設計文書に明記すべき。

### 2-B. 「Yes / No を Agent 自身が代行できないことをどう保証するか」

**結論: 現在の CLI は保証できていない。stdin を読む限り、保証は原理的に不可能。**

現状の多層防御を評価すると:

| 層 | 内容 | 評価 |
|---|---|---|
| MCP `deploy_secret` の分岐 | production/github は実行せず `action_required` | 有効 |
| `confirmProduction: async () => false` 固定 | MCP 経路では engine が本番実行に到達しない | 有効（良い設計） |
| CLI `confirmExact` | `stdin.isTTY` 必須 + 厳密 `yes` | **agent が pty を握れる host では突破可能** |

MCP 側は堅い。破れるのは **CLI 直叩き**の経路である。Codex の `exec_command(tty=true)` + `write_stdin("yes\n")` で、`npx api-key-case deploy X --target github` は完走しうる。MCP を塞いでも CLI が開いているので、境界としては現在すでに穴が空いている（Pro ライセンスと、その host を使っているかどうかだけが実質的な制約）。

**保証の作り方（唯一成立する形）:**

1. **承認の入力面を、プロセスの stdin から外す。** production / github の承認は `process.stdin` から読まない。読む先は「agent より前に、agent の外側で確立された面」= GUI ダイアログ、または人間が自分で起動した承認コンソール。
2. **承認を読んだプロセスが実行プロセスであること。** 承認トークンをファイルや IPC で受け渡さない。トークンを作った瞬間、agent が読めるファイル＝再利用可能な資格情報が生まれる（`AGENTS.md` §3-3 が「事前 dry-run 証跡の永続保存を要求しない」としているのと同じ理由）。
3. **どちらの面も使えない時は、承認を求めずに拒否する。** 「TTY があるからいいだろう」で fallback しない。既存の `cli-unavailable` と同じく「人間がやる手順」を出して終了する。
4. **MCP 側の常時 false 固定は維持する。**
5. 承認ダイアログには、**agent が偽造できない情報**を載せる: 解決済み CLI の絶対パス、`wrangler whoami` / `vercel whoami` 相当のログイン先、secret 名、target、env。argv は agent が作るが、ログイン先は agent が作れない。

これは既存境界の**強化**であって緩和ではない。ただし副作用として、人間が自分のターミナルで `deploy --env production` を実行したときも GUI ダイアログが出る（またはダイアログ不可環境では拒否される）ことになる。ここは製品判断が必要（§9-1）。

---

## 3. 推奨アーキテクチャ

### 3.1 基本方針: Control Plane と Human Plane を分ける

```
┌─ Control Plane（agent が触れてよい面。状態のみ） ────────────┐
│  npx -y api-key-case@latest next --json     ← 新規・中核     │
│  scan --json / check --json / list --json / targets --json   │
│  deploy（development/preview のみ、Pro）                      │
│  （任意）MCP 7ツール ← 既存のまま                              │
└──────────────────────────────────────────────────────────────┘
              │ 「次にやること」を返すだけ。値は絶対に返さない
              ▼
┌─ Human Plane（agent が読めない・書けない面） ────────────────┐
│  値の入力       : detached GUI ダイアログ → 直接 keyring      │
│  高リスク承認   : detached GUI ダイアログ → その場で実行      │
│  fallback       : 「人間が自分のターミナルで打つコマンド」提示  │
└──────────────────────────────────────────────────────────────┘
```

新規に増やす概念は **2つだけ**（`next` コマンドと Human Plane 抽象）。vault / scanner / adapters / engine / MCP は一切変えない。

### 3.2 中核: `api-key-case next --json`（判断を agent にさせない）

D2 への回答。既存の scan + vault.hasSecret + inspectTargets + readLicenseStatus を合成し、**「今やるべきこと」を型付きで返す**。agent はコマンド体系を覚える必要がなく、`nextActions` を上から実行するだけになる。

```jsonc
{
  "version": 1,
  "project": { "dir": "...", "projectId": "a1b2..." },
  "vault": { "available": true, "backend": "keyring" },
  "license": { "plan": "free" },              // entitlementId は絶対に載せない
  "hygiene": { "gitignoreOk": true, "leakFindings": 0 },
  "secrets": [
    { "name": "RESEND_API_KEY", "scope": "project", "status": "registered" },
    { "name": "PADDLE_API_KEY", "scope": "project", "status": "missing" }
  ],
  "targets": [ { "id": "cloudflare", "detected": true, "cliReady": true } ],
  "nextActions": [
    {
      "id": "save-PADDLE_API_KEY",
      "actor": "human",                        // ← agent はこれを実行しない
      "risk": "value-entry",
      "title": "PADDLE_API_KEY の値を入力する",
      "agentInstruction": "値をチャットに貼らせず、この行を実行して人間に入力面を出すこと",
      "command": ["npx","-y","api-key-case@latest","save","PADDLE_API_KEY","--ask"]
    },
    {
      "id": "deploy-RESEND_API_KEY-cloudflare-development",
      "actor": "agent",                        // ← agent が自律実行してよい
      "risk": "low",
      "title": "RESEND_API_KEY を Cloudflare(development) へ配置",
      "command": ["npx","-y","api-key-case@latest","deploy","RESEND_API_KEY","--target","cloudflare","--env","development"]
    }
  ]
}
```

設計上の要点:

- **`actor` フィールドが唯一の判断軸**になる。agent 向け指示は「`actor:"agent"` だけ実行し、`actor:"human"` は実行して人間面を開くか、そのまま人間へ渡す」の1行で済む。
- **プロトコルがパッケージ側にある**。将来コマンドが増えても、リポジトリに置いた instruction ファイルを書き換える必要がない → AC-5 が構造的に成立する。
- `next` は既存関数の合成のみ。新しい権限も新しい値経路も生まれない。
- **`entitlementId`・secret値・値の長さ・ハッシュは載せない。** `--json` 出力全体に対して「`value`/`secret`/`password` という名のキーが存在しない」機械テストを、MCP の inputSchema 検査（`SECURITY.md` MCP boundary）と同型で追加する。

### 3.3 配線: `api-key-case agent-init`（1回のbootstrapで完結させる）

D1 への回答。bootstrap prompt は**1行**にできる。

> `npx -y api-key-case@latest agent-init` を実行して、出力された手順に従ってください。

このコマンドが行うこと:

1. **stdout に運用プロトコルを出力する**（agent はこれを読んだ時点でその場で使える → AC-1 がこの1回で成立）。
2. **host ネイティブな指示ファイルへ、マーカー区切りの managed block を書く**（→ AC-5）:
   - `.claude/skills/api-key-case/SKILL.md` — Claude Code はリポジトリ直下 `.claude/skills/` を設定不要で自動探索し、`description` に基づきモデルが必要時に自動ロードする。本文は使う時までコンテキストを消費しない。
   - `AGENTS.md` の managed block — Codex / Cursor が読む。
   - `.cursor/rules/api-key-case.mdc` — Cursor の description ベース auto-attach。
   - `CLAUDE.md` は **AGENTS.md を読まない**ので別途必要（後述 §5）。既存 `CLAUDE.md` が `@AGENTS.md` を import している場合は追記しない。
3. `--mcp` 指定時のみ `.mcp.json` / `.cursor/mcp.json` / `.codex/config.toml` を書く（**既定オフ**。AC-2 は「MCP設定を要求しない」なので、MCP は任意のままにする）。

managed block の規律（`AGENTS.md`「ユーザーの既存変更を削除・巻き戻さない」より）:

- `<!-- BEGIN api-key-case (managed) -->` … `<!-- END -->` の外を絶対に触らない。
- block 内容のハッシュを block 末尾に埋め、人手編集を検出したら `--force` 無しでは上書きしない。
- 既存ファイルの保全は `scanner.ts:writeGeneratedFile()` の既存規約（存在すれば保存、`--force` で置換）をそのまま踏襲する。
- 書き込み先はプロジェクト内のみ。`~/.claude/skills/` への書き込みは `--user` 明示時のみ。
- `--check` で drift 検査のみ（CI 用、書き込みなし）。

managed block の中身は **最小限に固定する**（injection 面を小さく保つため。§7-1）:

```markdown
<!-- BEGIN api-key-case (managed) -->
This project uses API Key Case for API key handling.

- Before any work touching environment variables, API integrations, or deployment,
  run: `npx -y api-key-case@latest next --json` and follow `nextActions`.
- Execute only actions with `"actor": "agent"`. Run `"actor": "human"` actions to
  open the human input surface, or relay them; never perform them yourself.
- Never ask the user to paste a secret value into this conversation, and never
  read `.env` / `.env.*`.
<!-- END api-key-case (managed) -->
```

（`AI_SAFE_PROMPT.md` / `AGENT_CONTEXT.safe.md` は「実装時の制約」として現状のまま残す。役割が違うので統合しない。）

### 3.4 Human Plane: `askSecret()` / `askApproval()` の1インターフェース・3バックエンド

D3 への回答。`packages/core/humanplane/` を新設し、既存 `prompt.ts` はその1バックエンドとして残す。

```
interface HumanPlane {
  capability(): "os-dialog" | "own-terminal" | "handoff-only";
  askSecret(ref: SecretRef): Promise<"saved" | "cancelled">;   // 値を返り値にしない
  askApproval(plan: ApprovalPlan): Promise<boolean>;
}
```

**最重要の型設計**: `askSecret` は `Promise<string>` ではなく `Promise<"saved"|"cancelled">` を返す。**値が呼び出し元へ戻る型が存在しない**ので、`get_secret()` を作らないのと同じ理由で漏洩経路が構造的に消える。値はダイアログ実装の中で `vault.setSecret()` に直接渡される。

| backend | 選択条件 | 値・承認の経路 | agent からの可視性 |
|---|---|---|---|
| `os-dialog` | GUI セッションあり | detached helper: macOS `osascript display dialog ... with hidden answer` / Windows WPF PasswordBox / Linux `zenity --password`（要レビュー §9-3） → helper が直接 keyring へ書き、親には exit code のみ | **不可視**（window server 経由の打鍵。pipe を通らない） |
| `own-terminal` | 現行 `save` と同じ。`stdin.isTTY` かつ **人間が自分で起動した**とみなせる場合のみ | 既存 `promptSecretValue` / `confirmExact` | **可視**（親が pty を握っていれば） |
| `handoff-only` | 上記いずれも不可 | 「人間がターミナルで打つコマンド」を提示して終了（現状の `action_required` と同じ） | 値が発生しない |

そして §2-B の結論より、**承認 (`askApproval`) は `own-terminal` バックエンドを既定で許可しない**。`os-dialog` が使えなければ `handoff-only`（拒否＋手順提示）へ落ちる。値入力 (`askSecret`) は `own-terminal` を許容してよい（人間が自分で打った場合に限り安全で、かつそれが現行の唯一の手段だから）が、agent が起動したプロセスでは `--ask` 経由で必ず `os-dialog` か `handoff-only` になるようにする。

CLI 側の変更は最小:

- `save <NAME> --ask` : Human Plane 経由。TTY 不要。agent が呼んでよい唯一の save 形。
- `remove <NAME> --ask` : 同様（AC-6。破壊的なので必ず承認面を通す）。
- `deploy` の `confirmProduction` : `confirmExact`（stdin）から `humanPlane.askApproval` へ差し替え。
- MCP `save_secret` / `deploy_secret` : 返す `action_required` 文字列を `--ask` 形へ更新するだけ。**値パラメータ不在・常時 false 固定は一切変えない。**

---

## 4. 代替案と比較

配線（bootstrap）と 人間面（input/approval）は直交するので分けて比較する。

### 4.1 配線の選択肢

| 案 | security | UX | portability | 実装コスト |
|---|---|---|---|---|
| **W1. managed instruction + CLI JSON（推奨）** | 中: repo 内の指示文＝injection 面が増える（§7-1）。ただし新しい実行権限は増えない | 高: bootstrap 1行、2回目以降不要 | **高**: shell さえあれば全 host 共通。設定・再起動・trust 不要 | 低〜中 |
| W2. MCP 設定を自動書き込み | 中: `.mcp.json` を書く＝そのリポジトリを開くと agent がサーバーを起動しうる | 中: 型付きツールで綺麗だが、承認/再起動/trust が挟まる | **低**: Claude Code は `.mcp.json`（対話時のみ承認プロンプト）、Cursor は `.cursor/mcp.json`、Codex はプロジェクト `.codex/config.toml` に `trust_level="trusted"` が必要で Desktop は無視する既知issueあり | 中 |
| W3. Claude Code plugin / marketplace | 中 | 高（CC 限定） | **最低**: Claude Code 専用 | 中 |
| W4. 毎回 bootstrap prompt を貼る（現状+α） | 高（何も増えない） | 低（AC-5 不成立） | 高 | ゼロ |

→ **W1 を推奨。W2 は `--mcp` の任意オプションとして残す（既存 MCP 実装をそのまま活かせる）。**

### 4.2 人間面の選択肢

| 案 | security | UX | portability | 実装コスト |
|---|---|---|---|---|
| H1. 人間の自前ターミナル（現状） | **最高**（agent の外側） | 低（コマンドを知る必要／文脈切替） | 高 | ゼロ |
| **H2. detached OS ダイアログ（推奨）** | 高（打鍵が pipe を通らない。値は helper→keyring 直行）。残余: 同一UIDの ptrace / Linux の `DISPLAY` 乗っ取り | **高**（agent の流れを切らずに人間が1操作） | 中（GUI セッション必須。SSH/CI/devcontainer 不可 → fallback 必須） | 中 |
| H3. 新規ターミナルwindowをdetached起動 | 中〜高（新コンソールは親の pipe ではない） | 中（window が飛ぶ） | 低（Linux の端末エミュレータ検出が泥沼） | 中 |
| H4. `attend` 承認コンソール（人間が自分で起動、local IPC） | **高**（agent 非子孫・agent は「頼む」ことしかできない）。SSH/headless でも成立 | 中（人間が最初に1回起動する＝4つ目の作業） | 高 | **高**（unix socket / named pipe、権限、TTL、リプレイ、DoS、常駐ライフサイクル） |
| H5. MCP elicitation | **不可**（後述） | 高 | 中 | 低 |

**H5 を採用してはいけない理由（新しい根拠）**: Claude Code は MCP elicitation を完全サポートするが、同時に **`Elicitation` フックで「ダイアログを出さずに自動 accept / 値の自動供給」ができ、`ElicitationResult` フックで人間の回答を上書きできる**。つまり elicitation の回答は設定で機械化可能であり、AC-4 の「agent 自身では承認できない」を満たさない。値入力についても、値が MCP クライアント（= agent host プロセス）を通る時点で §2-A に反する。`phase-4-mcp.md` §2-17 の禁止は正しく、**今回の調査でその根拠がより強くなった**ので維持する。

→ **H2 を推奨、H1 を fallback として維持。H4 は Tier B（後述）。**

### 4.3 段階

- **Tier A（今回の推奨最小実装）**: W1 + H2 + H1 fallback。AC-1/2/3/5/6 を満たし、AC-4 を GUI 環境で満たす。
- **Tier B（将来・任意）**: H4 `attend` を追加。SSH/headless/devcontainer でも AC-4 が成立するようになる。IPC の攻撃面が増えるので、Tier A の運用実績を見てから判断する。

---

## 5. Claude Code / Codex / Cursor の差

| 項目 | Claude Code | Codex | Cursor |
|---|---|---|---|
| 指示ファイル | `CLAUDE.md` / `.claude/CLAUDE.md` / `.claude/rules/`。**`AGENTS.md` は読まない**（`@AGENTS.md` import か symlink が公式回避策） | `AGENTS.md` | `AGENTS.md` / `.cursor/rules/*.mdc` |
| スキル的な遅延ロード | `.claude/skills/<name>/SKILL.md` を設定不要で自動探索・description でモデルが自動起動・セッション中ホットリロード | 相当機能なし（AGENTS.md 常時ロード） | `.mdc` の description による auto-attach |
| MCP 設定 | `.mcp.json`（project scope）。対話セッションでは承認プロンプト、**`claude -p` / SDK / cloud では無承認でロード** | `~/.codex/config.toml`。プロジェクト `.codex/config.toml` は `trust_level="trusted"` 必須、Desktop が無視する既知 issue あり | `.cursor/mcp.json` + `cursor://` deeplink ワンクリック導入 |
| MCP prompts | コマンドとして露出する | — | — |
| MCP elicitation | **完全サポート、かつフックで自動応答/上書き可能** → 本製品では使用禁止 | 不明/未確認 | 不明/未確認 |
| shell の TTY | **本セッションで実測: `stdin.isTTY = undefined`**（pty 無し）。ただし harness 実装であり保証ではない | **`exec_command(tty=true)` で本物の PTY + `write_stdin` で打鍵可能** | agent terminal は非対話（PTY 使い回し）と報告 |
| 本製品への含意 | 現状では CLI 承認は事故的には破られない。skill 配線が最も綺麗 | **CLI の stdin 承認は agent に代筆されうる。最も強い駆動力があり、最も危険** | 中間。人間が agent terminal に打つ設計にはなっていない |

**含意**: 「TTY だから人間」という前提は host 依存で、Codex では既に成立しない。`agent-init` は host を検出して書き分ける必要がある（`.claude/skills/` + `CLAUDE.md` + `AGENTS.md` + `.cursor/rules/` を並べて書くのが現実解）。

---

## 6. AC-1〜AC-6 の達成可否

| AC | 可否 | 根拠 / 条件 |
|---|---|---|
| **AC-1** 1回の bootstrap prompt で利用可能に | ✅ | `agent-init` が stdout にプロトコルを出すので、その1回の実行で即使える。host 側の「コマンド実行許可」が1回入るが、それは host の権限モデルであり本製品では消せない（消すべきでもない） |
| **AC-2** 手動MCP設定を要求しない | ✅ | CLI + JSON を主経路にすれば設定ゼロ。MCP は `--mcp` の任意機能に留める |
| **AC-3** agent が必要性を判断し、人間は値入力だけ | ✅（GUI環境） / ⚠️（headless） | `next --json` の `nextActions[].actor` で判断が不要になる。値入力は `os-dialog` なら1操作。GUI 不可環境では `handoff-only`（人間が自分のターミナルで実行）へ劣化する — **ここは安全のために UX を落とす箇所** |
| **AC-4** 高リスクは Yes/No のみ・agent は自己承認不可 | ⚠️ **条件付き。現状は未達で、放置すると悪化する** | stdin 承認を廃し、`os-dialog`（または Tier B の `attend`）でのみ承認を受ける設計にすれば、agent host の通常ツール表面からは代筆できなくなる。**同一 OS ユーザーの任意コード（ptrace 等）に対しては保証できない**（§2-A 残余リスク） |
| **AC-5** 2回目以降は bootstrap 不要 | ✅ | managed block がリポジトリに残る。かつプロトコル本体はパッケージ側（`next --json`）にあるので、機能追加で block を書き換える必要がない |
| **AC-6** 削除等の日常管理もコマンド不要 | ✅ | `next --json` に `stale`（registry にあるが store に無い）や未使用 secret の整理アクションを載せ、`remove --ask` を human plane 経由にする。MCP へ `list_secrets` 追加は要判断（§9-4） |

---

## 7. 新たに生まれる attack surface

1. **リポジトリ内の指示文が agent への命令チャネルになる**（W1 の代償）。悪意ある PR が managed block を書き換えれば、agent は偽の手順に従いうる。緩和: block を極小・固定文面にし、任意コマンド実行を含めない。`agent-init --check` で drift を CI 検査。`README` を正本とし、block はそれを指すだけにする。
2. **`npx -y <package>` を agent に実行させる習慣**。タイポスクワッティング/サプライチェーンの入口。緩和: bootstrap 文面での正確なパッケージ名固定、README を唯一の正本にする。`@latest` の是非は §9-5。
3. **`agent-init` のファイル書き込み**。パストラバーサル、symlink 追従、ユーザーの既存 `CLAUDE.md` / `AGENTS.md` 破壊、`~/.claude/` へのグローバル汚染。緩和: プロジェクト外書き込みは `--user` 明示時のみ、`writeGeneratedFile` 規約の踏襲、symlink 拒否。
4. **`next --json` の情報集約**。これまで別々だった「必要 secret 名 / 登録状況 / target ログイン状態 / ライセンス」が1レスポンスに集まり、そのまま LLM コンテキストと host のログに入る。緩和: `entitlementId` を出さない、絶対パスは既存 scan 相当に留める、値・長さ・ハッシュを一切含めない機械テスト。
5. **GUI ダイアログ helper**。(a) Linux の `DISPLAY` / `XDG_*` / `PATH` は agent が子プロセス環境として制御できるため、**agent が用意した偽ダイアログや仮想 X サーバへ人間を誘導しうる**。(b) helper が値を argv/env で受けたら終わり（受けない設計にする）。(c) helper の stdout に値を出したら終わり（exit code のみにする）。(d) ダイアログ文面に agent 由来文字列（secret 名）が入るので、制御文字・改行・見た目の詐称対策が要る。
6. **承認ダイアログのフィッシング**。agent が「これは development です」と説明しつつ production を要求できる。緩和: ダイアログ文面は agent の説明ではなく **本製品が argv から生成した事実**のみを表示し、加えて agent が偽造できない「実際のログイン先」を表示する。
7. **`--ask` の悪用**。agent が繰り返し `save --ask` を叩いて人間にダイアログを連打する（同意疲労／DoS）。緩和: 同一プロセス系列でのレート制限、キャンセル時の即時終了。
8. **Tier B を採る場合の IPC**: Linux abstract socket は同一ユーザーの全プロセスから到達可能。ファイルソケット + 0600 + ユーザー専用ディレクトリ、Windows は named pipe に DACL、要求は単発・短TTL・リプレイ不可。
9. **telemetry の closed enum**。新コマンドを足すなら `CliTelemetryCommand` の enum を明示的に拡張するか、何も送らないかのどちらか。暗黙拡張は `SECURITY.md` の telemetry boundary に反する。

---

## 8. 最小実装 scope（Tier A）

新規ファイルは4つ、既存への変更は「差し替え」中心。

| # | 対象 | 内容 | 備考 |
|---|---|---|---|
| 1 | `packages/core/plan.ts`（新規） | `scanProject` + `vault.hasSecret` + `inspectTargets` + `readLicenseStatus` を合成し `NextPlan` を返す | 新しい権限・値経路ゼロ |
| 2 | `packages/cli/index.ts` | `next [path] [--json]` を追加（テキスト表示は人間向け） | `runObservedCommand` には載せない or telemetry enum を明示拡張 |
| 3 | `packages/core/agent-init.ts`（新規） | managed block の生成・マーカー書き込み・drift 検査 | `scanner.ts:writeGeneratedFile` の規約を再利用 |
| 4 | `packages/cli/index.ts` | `agent-init [--check] [--force] [--user] [--mcp]` | 既定はプロジェクト内のみ |
| 5 | `packages/core/humanplane/`（新規） | `index.ts`（capability 検出・backend 選択）、`dialog-*.ts`（OS別 helper 起動）、既存 `prompt.ts` を `own-terminal` backend として利用 | `askSecret` の返り値型に値を含めない |
| 6 | `packages/cli/index.ts` | `save --ask` / `remove --ask` を追加。`deploy` の `confirmProduction` を `humanPlane.askApproval` に差し替え | stdin 承認の既定廃止は §9-1 の判断待ち |
| 7 | `packages/mcp/messages.ts` | `action_required` の提示コマンドを `--ask` 形へ更新 | ツール定義・値パラメータ不在・常時 false は変更しない |
| 8 | `tests/run-tests.mjs` | (a) 全 `--json` 出力に value/secret/password キーが無い機械検査 (b) `askSecret` の戻り値型に値が無いことの禁止識別子テスト拡張 (c) `askApproval` が `process.stdin` を読まないこと (d) `agent-init` が managed block 外を書き換えないこと (e) canary テストを `next` にも適用 | 既存テスト方針の延長 |
| 9 | `docs/` / `README` / `SECURITY.md` | Human Plane の境界と残余リスク（同一OSユーザー、GUI不可時の劣化）を明記 | 免責文の維持 |

**やらないこと（スコープ外）**: 常駐デーモン、local IPC、MCP elicitation、承認トークンの永続化、`get_secret` 系の追加、allowlist 外 target、チーム機能。

---

## 9. 実装前に独立レビューすべき論点

1. **stdin 承認の廃止範囲**（最重要・製品判断）。production/github の承認を `process.stdin` から完全に外すと、GUI の無いサーバー上で人間が自分の SSH ターミナルから deploy する正当なユースケースが `handoff-only` で詰む。選択肢は (a) 完全廃止＋Tier B で救う、(b) 「GUI が使えるのに os-dialog を使わない」場合のみ stdin を許可、(c) 現状維持で Codex 経路のリスクを文書化。**(a) と (c) の中間を安易に作らないこと**が肝。
2. **`askSecret` の戻り値型**。「値が返る型を作らない」を本当にコード全体で守れるか（helper のプロセス境界、テストダブル、エラーパス）。`AGENTS.md` §3.2 の「実装してはいけない関数」と同じ強度でレビューする。
3. **Linux GUI バックエンドの是非**。`DISPLAY` / `XDG_SESSION_TYPE` / `PATH` はすべて agent が制御しうる子プロセス環境変数である。安全に「本物のユーザーセッションのダイアログ」だと判定する方法があるか。無ければ **Linux では os-dialog を採用せず handoff-only にする**判断もありうる（正直で安全）。
4. **MCP への `list_secrets` / `remove_secret` 追加**。`phase-4-mcp.md` §1.2 は両方を意図的に非公開とした。AC-6 のために覆すなら、その判断を文書で更新する（`list` は status-only で安全側、`remove` は破壊的で human plane 必須）。
5. **`npx -y api-key-case@latest` を指示文に焼き込むことの妥当性**。`@latest` は供給チェーン面が広い一方、バージョン固定は managed block を陳腐化させ AC-5 を壊す。
6. **`nextActions` の `actor` を agent が無視した場合**。`actor:"human"` のコマンドを agent が直接実行しても、`--ask` 経由なら human plane に落ちるので安全。**この「無視されても安全」性を全アクションについて検証する**（instruction は防御ではない）。
7. **承認ダイアログに載せる「偽造できない事実」の具体**。`wrangler whoami` 等の追加実行はコスト・失敗モードが増える。何を載せれば人間が誤承認を避けられるか。
8. **`agent-init` が書く先の host 検出ロジック**。存在しない host のファイルまで書くと、無関係なリポジトリ汚染になる。検出失敗時の既定（全部書く / 何も書かない / 聞く）。
9. **telemetry**。`next` / `agent-init` を計測対象にするか。するなら closed enum の拡張として `SECURITY.md` を更新する。

---

## 10. 成立しない要求と、最も近い安全な代替

固定 UX を弱めず、成立しない部分だけを明示する。

| 要求 | 成立可否 | 理由 | 最も近い安全な代替 |
|---|---|---|---|
| 「agent が起動したプロセスに人間が値を打てば安全」 | **不成立** | 親は子の stdio を所有する。本リポジトリの `pty-drive` が実証済み（`VERIFICATION.md:111`）。Codex は `exec_command(tty=true)` + `write_stdin` を標準装備 | 打鍵面を pipe の外へ出す: OS ダイアログ（値は helper→keyring 直行、親へは exit code のみ）。不可なら人間の自前ターミナル |
| 「Yes/No を agent が代行できないことを完全に保証」 | **完全保証は不成立** | 同一 OS ユーザーのプロセス間には信頼境界が無い（`SECURITY.md` 既記載）。stdin を読む限り「人間が打った」と「親が打った」を区別できない | (1) 承認を stdin から外し、agent より前に外側で確立された面（GUIダイアログ / 人間起動の attend）でのみ受ける (2) 承認したプロセスが実行する（トークンを作らない） (3) MCP の常時 false 固定を維持 (4) 「事故・prompt injection に対しては保証、悪意ある任意ローカルコードに対しては非保証」と脅威モデルを明記 |
| 「人間の作業を完全に3つだけにする」 | **環境依存で不成立** | GUI の無い環境（SSH / CI / headless container / 一部 devcontainer）ではダイアログが出せない | その環境では `handoff-only` に劣化させ、「人間が自分のターミナルで1行打つ」を提示する。**agent の pty へ打たせる方向へは決して劣化させない**。恒久的に埋めたければ Tier B（`attend`） |
| 「MCP elicitation で値入力/承認を受ける」 | **禁止のまま維持** | 値が agent host プロセスを通る。かつ Claude Code は `Elicitation` フックで自動 accept、`ElicitationResult` フックで人間の回答を上書きできる | Human Plane（§3.4） |
| 「agent が production まで完全自動化」 | **意図的に不成立**（`AGENTS.md` §3-3） | 製品の存在理由 | development / preview の deploy は `actor:"agent"` として完全自動化し、自動化の価値はそこで出す |

---

## 参考（調査時に確認した外部情報）

- Claude Code MCP scopes / elicitation: https://code.claude.com/docs/en/mcp
- Claude Code skills（`.claude/skills/` 自動探索・plugin 化）: https://code.claude.com/docs/en/skills
- Claude Code hooks（`Elicitation` / `ElicitationResult`）: https://code.claude.com/docs/en/hooks-guide
- Codex `exec_command` / `write_stdin` / `tty=true`: https://github.com/openai/codex/issues/18578
- Codex プロジェクト `.codex/config.toml` と trust: https://github.com/openai/codex/issues/13056 , https://github.com/openai/codex/issues/13025
- Cursor MCP / install links: https://cursor.com/docs/mcp , https://cursor.com/docs/context/mcp/install-links
- Cursor agent terminal の非対話性: https://forum.cursor.com/t/agent-terminal-handling-commands-that-require-user-input/143220
- Claude Code が `AGENTS.md` を読まない件: https://github.com/cli/cli/issues/14075

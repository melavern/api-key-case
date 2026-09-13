# Phase 4 Design — MCP Server (agent-facing tool surface)

> **履歴文書（2026-09-08整理）:** 以下はPhase 4導入時の設計記録。7ツール・stdio・値を受け取らず返さない境界は維持する。
> 現行`save_secret`は別の`save --ask`へhandoffし、高リスク配置のhandoff先CLIはHuman Planeで判断する。
> 本書の人の端末/TTYに関する記述を、Agentのstdin入力で承認できる仕様として使わない。
> 現行のMCP仕様は[MCP README](../../packages/mcp/README.md)、必須ではないMCPと主入口CLIの関係は
> [setup契約](agent-setup-readiness.md)を参照する。

> 対象読者: 実装を担当する AI エージェント（Sonnet / Codex クラス）および人間レビュアー。
> この文書は CLAUDE.md（リポジトリ直下）の下位文書である。**矛盾したら CLAUDE.md セクション3が常に勝つ。**
> 前提: [phase-2-vault.md](phase-2-vault.md) と [phase-3-deploy.md](phase-3-deploy.md) が実装済みであること。
> MCP は中級者向けの**任意オプション**（CLAUDE.md §2）。CLI が主、MCP は従。MCP のために CLI 側の構造を変えない。

---

## 1. ゴールと非ゴール

### 1.1 ゴール

Claude Code / Cursor / Codex 等のエージェントから、CLAUDE.md §3.1 の**状態のみ返すツール群**を直接呼べるようにする。エージェント体験の理想形は:

> 「このプロジェクトに必要なキーを調べて、足りないものを教えて。登録済みのものは Cloudflare に配置して」
> → エージェントが scan → check → deploy を自律実行。**値は一度もエージェントのコンテキストを通らない。**

- 起動: `api-key-case mcp`（stdio transport のサーバーを開始）
- 公開ツール: §4 の 7 つのみ。CLAUDE.md §3.1 の allowlist の部分集合
- すべてのツール応答は「OK/NG + 状態」のみ。値のパラメータを持つツールを**スキーマレベルで存在させない**

### 1.2 非ゴール（このフェーズでは実装しない）

- HTTP / SSE / Streamable HTTP transport（ネットワーク面を作らない。stdio のみ）
- MCP resources / prompts / sampling / elicitation（elicitation で値入力を受ける案は §2-17 により禁止）
- `test_connection(service)`: CLAUDE.md §3.1 に列挙されているが、core 側に実装が存在しない（値をサービス API に送る検証は設計論点が多い）。**今回は公開しない**。TODO として残す
- `remove` / `list`（保存済み一覧）の MCP 公開: 削除は破壊的操作、一覧はエージェントに不要（必要なのは required との突合であり check_secret で足りる）。公開しない
- MCP サーバーの認証・マルチクライアント対応

---

## 2. セキュリティ不変条件（Phase 2 §2 / Phase 3 §2 に追加）

Phase 2 の 1〜7、Phase 3 の 8〜14 はすべて引き続き有効。加えて:

15. **値を受け取るパラメータを持つツールを定義しない。** `save_secret` の inputSchema に `value` / `secret` / `password` 等のプロパティを追加することは、理由を問わず禁止（「エージェントが値を生成して渡したい」ケースが将来出ても、CLI の対話入力へ誘導する）。
16. **ツール応答（text / structuredContent）に値を含める経路を作らない。** 応答の組み立ては CLI と同じ core 関数の戻り値（状態オブジェクト）のみから行う。deploy のスクラブ済み出力（Phase 3 §5.1）はそのまま転送してよい（スクラブ済みであることが前提条件）。
17. **MCP プロトコル上のいかなるメッセージにも値を乗せない。** elicitation（クライアント UI 経由のユーザー入力）で値を受ける実装をしない — 値が MCP クライアント（=エージェントホストプロセス）を経由することになり、境界1（値の経路の限定）に違反する。値の入力は常に「人間がターミナルで `api-key-case save` を実行する」に誘導する。
18. **production 相当の deploy を MCP 経由で完結させない。** エージェントは確認プロンプトに自分で "yes" を供給できてしまうため、`deploy_secret` は production（および github target。Phase 3 §6.3）に対して実行せず、人間が実行すべき CLI コマンドを提示する応答を返す。engine へ渡す `confirmProduction` コールバックは**常に false を返す実装に固定**する（多層防御: 分岐ロジックにバグがあっても engine 側で本番実行が成立しない）。
19. **transport は stdio のみ。** listen するポートを持たない。

---

## 3. 起動とクライアント登録

### 3.1 起動コマンド

`packages/cli/index.ts` に `mcp` コマンドを追加。stdout は JSON-RPC 専用になるため、**サーバー起動後は console.log を一切使わない**（診断メッセージは stderr へ）。

```
api-key-case mcp [path]     # path = プロジェクトルートの既定値（省略時 process.cwd()）
```

### 3.2 ユーザー向け登録手順（README に記載する内容）

```
# Claude Code
claude mcp add api-key-case -- npx -y api-key-case mcp

# Cursor (mcp.json)
{ "mcpServers": { "api-key-case": { "command": "npx", "args": ["-y", "api-key-case", "mcp"] } } }
```

---

## 4. 公開ツール仕様

依存: `@modelcontextprotocol/sdk`（実装前に `npm view` で最新安定版を確認しメジャー固定）。各ツールは core の既存関数の薄いラッパであり、**このフェーズで新しいビジネスロジックを書かない**。

共通事項:
- `path` パラメータ: 省略時は起動時の既定プロジェクトルート。指定時は存在するディレクトリであることを検証。
- 応答は text（CLI と同じ `OK:` / `NG:` 行）+ structuredContent（CLI の `--json` と同スキーマ）の両方を返す。

| # | tool | input | 実体 | 応答（状態のみ） |
|---|---|---|---|---|
| 1 | `list_required_secrets` | `{ path? }` | `scanProject().requiredSecrets` | キー名の配列 |
| 2 | `check_secret` | `{ name, scope?, path? }` | vault.hasSecret | `registered` / `missing` |
| 3 | `save_secret` | `{ name, scope? }` — **value プロパティは存在しない** | なし（実行しない） | `action_required`: 「人間に `npx api-key-case save <NAME>` の実行を依頼せよ」という定型指示文 |
| 4 | `deploy_secret` | `{ name, target, env?, scope?, path?, dryRun? }` | Phase 3 engine | 下記 §4.1 |
| 5 | `generate_env_example` | `{ path?, force? }` | scanProject writeEnvExample | written / preserved |
| 6 | `scan_secret_leaks` | `{ path? }` | `scanProject()` | リダクション済み findings 要約（Phase 1 の agent-report と同等の内容） |
| 7 | `check_gitignore` | `{ path? }` | scanProject の envFiles.ignored | OK/NG + 対象ファイル一覧 |

### 4.1 deploy_secret の分岐

```
if (env === "production" || target === "github")
  → 実行せず action_required 応答:
    "Production deploys require human confirmation in a terminal.
     Ask the human to run: npx api-key-case deploy <NAME> --target <target> --env <env>"
else
  → assertProFeature("deploy")（Phase 5 ゲート。未ライセンス時は購入案内の NG 応答）
  → engine を dryRun フラグ付きで実行（dryRun=true なら計画のみ返す）
  → confirmProduction は常に false（§2-18。この分岐に到達する時点で production ではないが、固定する）
  → 結果: OK/NG + スクラブ済み出力の要約
```

---

## 5. アーキテクチャ

### 5.1 ファイル構成（新規）

```
packages/mcp/server.ts    // McpServer 組み立て・stdio 接続（起動はしない: createMcpServer() を export）
packages/mcp/tools.ts     // 7 ツールの定義（inputSchema + handler）。handler は core 関数の呼び出しと応答整形のみ
packages/mcp/messages.ts  // action_required 等の定型応答文（save/deploy の人間依頼テンプレート）
```

- `packages/cli/index.ts` の `mcp` 分岐は `createMcpServer(defaultProjectDir)` を呼んで stdio transport に接続するだけ。
- tools.ts から vault / engine へは Phase 2・3 と同じ DI 構造で渡す（keyring vault + 静的 adapter registry + 常時 false の confirmProduction）。
- 既存の `packages/mcp/README.md`（スタブ）を実仕様に書き換える。

### 5.2 エラーの扱い

- ツール handler 内の例外は MCP の `isError: true` 応答に変換する。**例外メッセージをそのまま転送せず**、CLI と同じ定型 NG 文言に差し替える（スタックトレース経由の情報漏れ防止。CLAUDE.md §3「ログ・エラー・スタックトレースにも本文を出さない」）。
- vault バックエンド不可（Phase 2 §4.4）は「OS secret store unavailable」の定型 NG。

---

## 6. 既存コードへの変更

- `packages/cli/index.ts`: `mcp` コマンド分岐を追加。ヘルプに追記（「optional, for agents — the CLI remains the primary interface」の一文を入れる）。
- `package.json`: `@modelcontextprotocol/sdk` を dependencies に追加。version を `0.5.0` に。
- `tests/run-tests.mjs`: §7 のテストを追加。禁止識別子テストの対象に `packages/mcp/*.ts` を追加。
- `README.md`: §3.2 の登録手順、「MCP はオプションであり、値は MCP プロトコル上を一切流れない」ことを追記。

---

## 7. テスト計画（tests/run-tests.mjs に追加）

方針: サーバーを実際に spawn し、生の JSON-RPC を stdio で流して検証する（SDK クライアントを test 依存に足してもよいが、手書き JSON-RPC で十分）。

1. **プロトコル面の canary テスト（最重要）**: canary 値を含む `.env` を持つフィクスチャプロジェクトに対し、`initialize` → `tools/list` → 全ツールを一巡 `tools/call` し、**サーバーが出力した全 stdout バイト列に canary が含まれない**ことを検証
2. **ツール表面の検査**: `tools/list` の結果が §4 の 7 つと完全一致（過不足なし）。`save_secret` の inputSchema のプロパティ集合に `name` / `scope` 以外が存在しない（`value` 系プロパティの混入を機械検査）
3. **save_secret**: 呼び出し結果が action_required 定型文であり、vault に何も書かれない
4. **deploy_secret (production)**: 実行されず（偽 CLI 記録ファイルなし）、人間依頼の定型文が返る。`target: "github"` も env に関わらず同様
5. **deploy_secret (development, dryRun)**: 計画のみ返り、値が読まれない（インプロセス版: tools.ts の handler を MemoryVault + 偽 CLI で直接呼ぶ — プロセス版は実 keyring 依存になるため e2e ゲート側）
6. **エラー整形**: 存在しないディレクトリの path → 定型 NG、スタックトレースが応答に含まれない
7. **禁止識別子テスト**: `packages/mcp/*.ts` を対象に追加。`getPassword` / OS ストア read API の出現は `packages/core/vault/keyring.ts` と `packages/core/deploy/handoff.ts` の二ファイルに限定されること（Phase 3 §10-9）も再確認
8. 既存テスト（scan / vault / deploy）が全て green のまま

---

## 8. 受け入れチェックリスト（実装完了の定義）

- [ ] `npm test` 全件 green（新規テスト含む）
- [ ] §2 の不変条件 15〜19 をコードレビューで確認できる（特に: save_secret に値パラメータがない / production が MCP で完結しない / stdio のみ）
- [ ] Claude Code に実登録し、「必要なキーを調べて」「登録状況を確認して」「development に配置して」の3操作がエージェント発話だけで完了する
- [ ] production 配置を依頼すると、エージェントが人間にターミナル実行を依頼する挙動になる
- [ ] サーバー起動中に stdout へ JSON-RPC 以外が混ざらない（Claude Code 側でパースエラーが出ない）
- [ ] `npm pack` → クリーン環境で `npx api-key-case mcp` が起動する
- [ ] README / packages/mcp/README.md 更新、免責文が残っている

---

## 9. Phase 5 への引き継ぎメモ

- `deploy_secret` は既に `assertProFeature("deploy")` を通過する構造（§4.1）。Phase 5 はゲートの中身を実装するだけで MCP 側の変更は不要のはず。
- 未ライセンス時の MCP 応答は「購入 URL を含む定型 NG」になる — エージェントがそれをユーザーに伝えるところまでが無料体験の導線になる（Phase 5 設計書で文言を決める）。

## 10. 実装メモ（2026-07-03、実装時に確定した解釈）

- `isError` の使い分け: §5.2 は「例外 → `isError: true`」しか規定していなかったため、実装時に以下を確定させた。
  - `isError: true`（処理そのものが失敗）: 不正な `path` / 不正な `NAME` / 不正な `target`・`env` / OS シークレットストア利用不可 / ハンドラ内の想定外例外。
  - `isError` なし・text は `NG:` 始まり（正常系の「状態」応答）: `missing-secret` / vault 利用不可以外の `check_secret` の `missing` / `cli-unavailable` / `deploy` 失敗 / `.gitignore` 要見直し。CLI の対応コマンドが exit 0 で `NG:` を出す場合と揃えている。
- `ToolDeps` に Phase 3 の `EngineDeps` と同じ形の `pathOverride`（テスト専用）を追加した。`tools.ts` の `buildTools()` は素の関数群を返し、`registerAllTools()` がそれを `McpServer.registerTool` に配線する形にした。これにより、テスト（`tests/run-tests.mjs`）は実サーバーを spawn しなくても `buildTools({ createVault: () => new MemoryVault(), adapters: fakeMap, pathOverride })` で production/github 分岐・dry-run・missing-secret・save_secret 未タッチ・エラー整形を in-process で検証できる（§7 の 3〜6）。実サーバーを spawn する JSON-RPC テスト（§7 の 1〜2、canary 検証・ツール一覧・スキーマ検査）は実 OS シークレットストアへの読み取りのみ発生し得るが、これは既存の Phase 2/3 テストが `check`/`targets` を実 CLI 経由でゲートなしに読んでいるのと同じパターン（値の書き込みだけを `AGENT_KEY_CASE_E2E=1` でゲートする）。
- 依存追加: `@modelcontextprotocol/sdk@^1.29.0`（実装時点の最新）、`zod@^4.4.3`（SDK の peerDependency `^3.25 || ^4.0` を満たす最新）。

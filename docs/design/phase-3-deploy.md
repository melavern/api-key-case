# Phase 3 Design — Deploy Adapters (Cloudflare / Vercel / GitHub)

> **履歴文書（2026-09-08整理）:** 以下はPhase 3導入時の設計記録。現在はPhase 6のHuman Plane、
> 実行snapshot、destination trustが加わっている。本書のTTY/`confirmProduction`例は現行の承認経路ではない。
> production・GitHub以外もhigh-riskまたは初回/変化した配置先なら人間確認を要する。
> 現行の条件は[README](../../README.md#deploying-secrets-deploy--targets--pro-feature)、
> [SECURITY](../../SECURITY.md)、[setup契約](agent-setup-readiness.md)を参照する。

> 対象読者: 実装を担当する AI エージェント（Sonnet / Codex クラス）および人間レビュアー。
> この文書は CLAUDE.md（リポジトリ直下）の下位文書である。**矛盾したら CLAUDE.md セクション3が常に勝つ。**
> 前提: [phase-2-vault.md](phase-2-vault.md) が実装済みであること（Vault / SecretRef / naming / registry / prompt を再利用する）。

---

## 1. ゴールと非ゴール

### 1.1 ゴール

OS シークレットストアに保存済みの秘密を、**値を一度も画面・ログ・AI に出さずに**、公式 CLI 経由で各プラットフォームへ配置する。これが有料コア機能（CLAUDE.md §5 Phase 3）。

- `api-key-case deploy <NAME> --target <cloudflare|vercel|github> --env <env>` — 配置実行
- `api-key-case targets` — 対象プロジェクトでどの配置先が検出されるか・公式 CLI が使えるかの診断
- production への配置は**要約提示 → 対話確認必須**、`--dry-run` 対応（CLAUDE.md §3-3）
- 配置先は **3社固定の allowlist**（CLAUDE.md §3-4）。4社目は作らない
- アダプタは共通インターフェースで実装し、「枠を1回作れば横展開できる」形にする（CLAUDE.md §4）

### 1.2 非ゴール（このフェーズでは実装しない）

- 各社 API の直叩き（公式 CLI ラップのみ。CLAUDE.md §8）
- 複数キーの一括デプロイ（`deploy --all` 等）。エージェントがコマンドを繰り返せば足りる。将来候補としてメモのみ
- プラットフォーム側に登録済みの値の読み出し・一覧・比較
- ライセンス課金の実体（Phase 5）。ただしゲート関数の**挿し込み口だけ**用意する（§9）
- MCP 公開（Phase 4）
- 4社目以降のアダプタ・team スコープ

---

## 2. セキュリティ不変条件（Phase 2 §2 に追加。破りそうになったら手を止めて TODO を残すこと）

Phase 2 の不変条件 1〜7 はすべて引き続き有効。加えて:

8. **値の受け渡しは「OS ストア → 子プロセスの stdin」の一経路のみ。** 値をコマンドライン引数（argv）・環境変数・一時ファイルに**乗せない**。3社の公式 CLI はいずれも stdin から値を受け取れる（§6 参照）ため、例外は不要。
9. 値を**保持して配置へ渡せる**コードは `packages/core/deploy/handoff.ts` の **1 モジュールに限定**する。このモジュールの関数は値を**戻り値・例外・ログに含めない**（読んで、子プロセス stdin に書いて、捨てる）。存在確認のためだけに `packages/core/vault/keyring.ts` の `hasSecret` が OS ストアの read API を呼び、結果を直ちに boolean へ畳むことは許容する。その他のモジュールに値を保持する読み取り処理を書かない。
10. **子プロセスの出力はスクラブしてから表示する。** 公式 CLI が値をエコーバックする可能性に備え、キャプチャした stdout/stderr 内の値の出現をすべて `***REDACTED***` に置換してからユーザーに見せる（多層防御）。スクラブ前の生出力をファイル・ログに書かない。
11. **allowlist はコードで閉じる。** target は TypeScript の閉じた union（`"cloudflare" | "vercel" | "github"`）とし、アダプタ登録は静的な Map。設定ファイルや環境変数から任意コマンド・任意 URL を注入できる口を作らない。
12. **子プロセスは `shell: false` で、検証済みトークンのみを argv に渡す。** NAME は `^[A-Z][A-Z0-9_]{0,127}$`、env は閉じた enum なので、シェルメタ文字が argv に混入する余地を作らない。
13. **プロジェクトローカルの `node_modules/.bin` から配置先 CLI を実行しない。** 悪意あるリポジトリが偽 `wrangler` を仕込むと、stdin 経由で値を窃取できてしまう。バイナリは PATH（グローバルインストール）から解決する。ローカル実行への対応要望が出ても、このフェーズでは緩めず TODO を残す。
14. **production への配置は対話確認（TTY）必須で、これをスキップするフラグを作らない。** `--yes` に相当する迂回路が存在するとエージェントが自律的に本番を書き換えられてしまう。CI から本番 Secret を流し込みたいケースは本製品のスコープ外（人間が輪の中にいることが製品価値）と明記する。

---

## 3. CLI 仕様

出力言語は既存に合わせて**英語**。既存コマンド（scan / save / check / list / remove）の挙動は一切変えない。

### 3.1 コマンド一覧

```
api-key-case deploy <NAME> --target <cloudflare|vercel|github>
                     [--env production|preview|development]
                     [--scope user|project] [--dry-run] [--force] [path]
api-key-case targets [path] [--json]
```

- `--env` 省略時のデフォルトは `development`。**production をデフォルトにしない。**
- `--scope` 省略時は `project`。project に無ければ user へ**暗黙フォールバックしない**（どの値が配置されたか曖昧になるのは事故のもと）。見つからなければ `NG: <NAME> is not registered in project scope. Try --scope user or run: api-key-case save <NAME>` で exit 1。
- `--dry-run`: 検出・CLI 状態確認・Vault 存在確認・実行計画の表示までを行い、**spawn せず** exit 0。値の読み出しも行わない。
- `--force`: 配置先に同名 Secret が既に存在して公式 CLI がエラーを返す場合（Vercel）に、削除→再登録のプランへ切り替える（§6.2）。
- `path`: プロジェクトルート。省略時 `process.cwd()`。

### 3.2 deploy の実行フロー（全 target 共通）

```
1. NAME / target / env / scope をバリデーション
2. adapter.detect(projectDir)       … 設定ファイル等から配置先の妥当性を確認（不一致は警告、ブロックはしない）
3. adapter.checkCli()               … CLI の存在・ログイン状態を確認。無ければ手動3ステップを表示して exit 5
4. vault.hasSecret(ref)             … 未登録なら exit 1（値はまだ読まない）
5. plan = adapter.planDeploy(...)   … 実行 argv と人間向け要約を組み立て（副作用なし）
6. 要約を表示:
     Deploy plan:
       secret : OPENAI_API_KEY (project scope)
       target : cloudflare (wrangler)
       env    : production
       command: wrangler secret put OPENAI_API_KEY --env production
       note   : this may overwrite an existing value on the platform.
7. --dry-run ならここで exit 0
8. env === "production" のとき: TTY で "Type 'yes' to deploy to production: " を要求。
   非 TTY なら exit 4。"yes" 以外の入力も exit 4（スキップフラグは存在しない。§2-14）
   production 以外: 確認なしで続行（非対話でも可）
9. runWithSecret(ref, plan)         … 値を読み、子プロセス stdin へ書き、スクラブ済み出力と exit code を得る
10. 結果表示: OK: OPENAI_API_KEY deployed to cloudflare (production). / NG + スクラブ済みエラー抜粋
```

### 3.3 targets の出力

```
Deploy targets for /path/to/project:
  cloudflare  detected (wrangler.toml)     cli: wrangler 4.x, logged in
  vercel      not detected                 cli: not installed
  github      detected (git remote)        cli: gh 2.x, not logged in (run: gh auth login)
```

`--json` は `{ targets: [{ id, detected, detectReason, cliInstalled, cliVersion, loggedIn, hint }] }`。値は構造上含まれない。

### 3.4 終了コード（Phase 2 の表に追加）

| code | 意味 |
|---|---|
| 0 | 成功（dry-run 完了含む） |
| 1 | 一般エラー（バリデーション・未登録・deploy 先 CLI のエラー等） |
| 3 | vault バックエンド利用不可（Phase 2 と同じ） |
| 4 | production 確認が得られなかった（非 TTY / ユーザーが拒否） |
| 5 | 配置先 CLI が未インストールまたは未ログイン（手動3ステップを表示済み） |

---

## 4. アーキテクチャ

### 4.1 ファイル構成（新規）

```
packages/core/deploy/types.ts     // DeployTarget interface, DeployPlan, DetectResult, CliStatus, env enum
packages/core/deploy/engine.ts    // 共通フロー（§3.2 の 1〜10）。Vault と adapter を DI で受ける
packages/core/deploy/handoff.ts   // runWithSecret — 値を保持して配置へ渡す唯一のモジュール（§5）
packages/core/deploy/which.ts     // PATH からの CLI バイナリ解決（Windows .cmd 対応。§5.3）
packages/adapters/cloudflare.ts   // 各アダプタ（§6）
packages/adapters/vercel.ts
packages/adapters/github.ts
packages/adapters/index.ts        // 静的 allowlist: Map<TargetId, DeployTarget>
```

- `packages/adapters/` を core から分離するのは、有料化（Phase 5）で**このディレクトリごと非公開パッケージへ移設**できるようにするため。core → adapters への import は `adapters/index.ts` の registry 経由のみとし、逆方向（adapters → core）は `deploy/types.ts` の型のみに依存させる。
- engine は端末入出力を直接持たない。確認プロンプトはコールバック（`confirmProduction: () => Promise<boolean>`）として CLI 側から注入する（テスト容易性と、core が TTY を知らない構造の維持）。

### 4.2 型定義（types.ts）

```ts
export type TargetId = "cloudflare" | "vercel" | "github";
export type DeployEnv = "production" | "preview" | "development";

export interface DeployPlan {
  argv: string[];            // argv[0] = CLI名（"wrangler" 等）。値は絶対に含めない
  valueVia: "stdin";         // 現状 stdin のみ。他の受け渡し方法を追加しない
  displayCommand: string;    // 表示用の1行（argv を join したもの）
  overwriteWarning: boolean; // 既存値を上書きしうるか
  preSteps?: DeployPlan[];   // --force 時の削除ステップ等（値を扱わないコマンドのみ）
}

export interface DeployTarget {
  readonly id: TargetId;
  readonly cliCommand: string;                       // "wrangler" | "vercel" | "gh"
  detect(projectDir: string): Promise<DetectResult>;
  checkCli(): Promise<CliStatus>;                    // {installed, version?, loggedIn, hint?}
  planDeploy(name: string, env: DeployEnv, opts: { force: boolean }): DeployPlan;
  manualSteps(name: string, env: DeployEnv): string[]; // CLI 不在時の手動3ステップ
}
```

---

## 5. handoff.ts — 値を保持して配置へ渡す唯一のモジュール

### 5.1 シグネチャ

```ts
export interface HandoffResult {
  exitCode: number | null;
  stdoutRedacted: string;   // 値の出現を ***REDACTED*** に置換済み
  stderrRedacted: string;
  timedOut: boolean;
}

// Reads the secret, writes it to the child's stdin, and discards it.
// The secret value MUST NOT appear in the return value, thrown errors, or any log.
export async function runWithSecret(
  vault: Vault,               // Phase 2 の Vault では値を読めないため、
  ref: SecretRef,             // keyring Entry への直接アクセスをこのモジュール内に限定して実装する
  plan: DeployPlan,
  opts?: { timeoutMs?: number } // default 120_000
): Promise<HandoffResult>;
```

### 5.2 実装規則

- Phase 2 の `Vault` インターフェースには値を返すメソッドが**存在しない**（意図的）。配置値を保持する必要があるため、handoff.ts は `@napi-rs/keyring` の `Entry.getPassword()` を**このファイル内で直接**呼ぶ。`vault/keyring.ts` の `hasSecret` も存在確認のために同じOS read APIを呼ぶが、値を boolean へ畳んで返すだけで保持しない。account 文字列の導出は Phase 2 の `naming.ts` を再利用する。
- **`getPassword()` は未登録エントリで例外を投げず `null` を返す**（Phase 2 実装時に Windows 実機で確認済み。phase-2-vault.md §4.3 参照）。`null` の場合は子プロセスを spawn せず、`NG: <NAME> is not registered. Run: api-key-case save <NAME>` 相当のエラーで中断する。例外ベースの分岐を書かないこと。
- 手順: `getPassword()`（null チェック）→ `spawn(resolvedPath, argv.slice(1), { shell: false, windowsHide: true })` → `child.stdin.write(value)` → `child.stdin.end()` → 変数を `""` で上書きして参照を捨てる（GC 前提のベストエフォート。コメントで明記）。
- スクラブ: 収集した stdout/stderr に対し、値の完全一致出現を全置換。値が 8 文字未満ならスクラブ対象文字列としては短すぎて誤爆するため、その場合は**出力全体を破棄**して `"(output withheld: secret too short to redact safely)"` に差し替える。
- タイムアウト時は child を kill し、`timedOut: true` を返す（値は既に stdin へ書き終えているか否かに関わらず追加処理なし）。
- `preSteps`（値を使わない削除コマンド等）は stdin に何も書かずに実行する。値の読み出しは本体プラン実行の直前 1 回のみ。

### 5.3 which.ts — バイナリ解決（Windows 対応）

- PATH から `wrangler` / `vercel` / `gh` の絶対パスを解決する（Windows は `.cmd` / `.exe` / `.bat` を探索）。
- Node 20+ は `.cmd` を `shell: false` で spawn すると `EINVAL` になる（CVE-2024-27980 対策の仕様）。**回避策**: 解決結果が `.cmd`/`.bat` のときのみ `cmd.exe /d /s /c "<absolutePath>" <args...>` 形式で spawn する。argv は §2-12 の通り正規表現・enum 検証済みトークンのみなので、この経路でもインジェクションは成立しない——ただしこの前提をコメントで明記し、**検証されていない文字列を argv に足す変更を禁止**する。
- `node_modules/.bin` を探索パスに**含めない**（§2-13）。

---

## 6. アダプタ仕様

3社とも「stdin から値を受け取れる公式 CLI」を持つため、valueVia は stdin で統一できる。
**実装前に各 CLI の最新版でコマンド形とログイン確認方法を必ず実挙動で確認し、differ があればこの表を更新してから実装すること**（CLI 仕様は変わりやすい。CLAUDE.md §2 の「追従コスト最小化」の原則）。

### 6.1 cloudflare.ts（wrangler）

| 項目 | 内容 |
|---|---|
| detect | `wrangler.toml` / `wrangler.json` / `wrangler.jsonc` の存在 |
| checkCli | `wrangler --version` → installed、`wrangler whoami` → loggedIn（timeout 15s） |
| deploy argv | `wrangler secret put <NAME>`（値は stdin） |
| env マッピング | `production` → 引数なし（wrangler のトップレベル環境）。`preview`/`development` → `--env <env>`（wrangler.toml に同名の named environment が必要。無い場合は wrangler 側のエラーをスクラブして表示） |
| 上書き挙動 | 既存キーは黙って上書きされる → `overwriteWarning: true` |
| manualSteps | 1. `npm i -g wrangler` 2. `wrangler login` 3. `production` は `wrangler secret put <NAME>`、それ以外は `wrangler secret put <NAME> --env <env>`（値はプロンプトに手で貼り付け）。**planDeploy と同じ env 分岐にすること** |

### 6.2 vercel.ts（vercel）

| 項目 | 内容 |
|---|---|
| detect | `.vercel/project.json`（リンク済み）または `vercel.json` の存在。リンク未済なら hint に `vercel link` を出す |
| checkCli | `vercel --version` → installed、`vercel whoami` → loggedIn |
| deploy argv | `vercel env add <NAME> <env>`（値は stdin。env は production/preview/development をそのまま渡せる）。`production` / `preview` には `--sensitive` を必ず付ける（Vercel側のdefaultに依存せず write-only storage を要求する）。`development` はVercel APIがsensitiveを許可せず `--sensitive` がerrorになるため付けない |
| 上書き挙動 | 同名が既にあると CLI がエラー → その旨を NG 表示する。`--force` は provider が重複する既存 Secret を明示した場合に、人間が次の操作へ同意したときだけ検討する |
| --force | preSteps に `vercel env rm <NAME> <env> --yes` を積んでから add（rm は値を扱わないので stdin 不使用）。production ではこの削除も §3.2-8 の確認の対象に含める（要約に "removes existing value first" を明記）。timeout・権限不足・結果不明・provider障害の一般的な再試行には使わない。 |
| manualSteps | 1. `npm i -g vercel` 2. `vercel login` → `vercel link` 3. `vercel env add <NAME> <env>`（値は手で貼り付け）。**planDeploy と同じ env 分岐にすること**（`production`/`preview` は `--sensitive` 付き） |

### 6.3 github.ts（gh）

| 項目 | 内容 |
|---|---|
| detect | git remote の URL に `github.com` を含む（Phase 1 の `packages/core/git.ts` にヘルパーがあれば再利用） |
| checkCli | `gh --version` → installed、`gh auth status` → loggedIn |
| deploy argv | `gh secret set <NAME>`（値は stdin。Actions のリポジトリ Secret）。`--env` 指定時は `gh secret set <NAME> --env <env>`（GitHub 側に同名の deployment environment が必要） |
| env マッピング | GitHub の Secret には repository / environment の2種類がある。`development` はリポジトリ Secret（引数なし = 全 workflow から利用可）にマップ。`--env production` / `--env preview` は「その名の GitHub Environment の Secret」（`environment:` を宣言した job のみ利用可）として扱い、要約にその旨を表示。**既定の `development` が3社の中で最も広いスコープになる**点に注意 |
| 上書き挙動 | 黙って上書き → `overwriteWarning: true` |
| production 扱い | repository / environment のどちらの Secret も CI が消費するために置かれ、どの workflow が読むかを本ツールは把握できないため、`--env` に関わらず **github への deploy は常に production 相当として確認を要求する**（安全側に倒す） |
| manualSteps | 1. `winget install GitHub.cli` / `brew install gh` 2. `gh auth login` 3. `development` は `gh secret set <NAME>`、`production`/`preview` は該当 Environment の作成を促したうえで `gh secret set <NAME> --env <env>`（値は手で貼り付け）。**planDeploy と同じ env 分岐にすること**（案内する手順が実行される内容と食い違わないように） |

---

## 7. 手動フォールバック（CLI 不在時）

CLAUDE.md §2「CLI が無い環境では『次にやる手動3ステップ』を返す」の実装。exit 5 とともに:

```
NG: wrangler is not installed. Do these 3 steps manually:
  1. npm i -g wrangler
  2. wrangler login
  3. wrangler secret put OPENAI_API_KEY   (paste the value when prompted)
Note: api-key-case never prints the value. Copy it from where you originally saved it.
```

---

## 8. 既存コードへの変更

- `packages/cli/index.ts`: `deploy` / `targets` コマンドの分岐を追加。engine への依存注入（vault, adapter registry, confirmProduction コールバック, promptSecretValue は不要）。ヘルプに追記。
- `tests/run-tests.mjs`: §10 のテストを追加。禁止識別子テストの対象に `packages/core/deploy/*.ts` と `packages/adapters/*.ts` を追加。
- `package.json`: version を `0.4.0` に。**新規 npm 依存は追加しない**（spawn は node:child_process、which は自前実装で足りる）。
- `README.md` / `SECURITY.md`: deploy の値の経路（OS ストア → 子プロセス stdin のみ）、production 確認に迂回路がないこと、ローカル bin を実行しないことを追記。免責文は維持。

---

## 9. Phase 5 への挿し込み口（ゲート関数）

CLAUDE.md §1「無料層と有料層をコードレベルで明確に分離（フラグで出し分け）」に備え、deploy コマンドの入口に 1 箇所だけゲートを置く:

```ts
// packages/core/license.ts
export function assertProFeature(feature: "deploy"): void {
  // Phase 3: always allowed. Phase 5 will implement license validation here.
}
```

- 呼び出し箇所は CLI の deploy 分岐冒頭の **1 箇所のみ**。散らばらせない（Phase 5 で差し替えるのはこの関数の中身だけにする）。
- ここで課金 UI・オンライン検証等を先取り実装**しない**。

---

## 10. テスト計画（tests/run-tests.mjs に追加）

方針: engine とアダプタは **dist からインプロセスで** MemoryVault と偽 CLI を注入してテストする（Phase 2 §4.5 の「CLI にバックエンド切替フックを作らない」原則を維持するため、プロセスレベルの deploy テストはバリデーション・拒否経路に限定する）。

**偽 CLI フィクスチャ**: テスト用一時ディレクトリに、stdin を受けてファイルに記録する小さな node スクリプトを `wrangler`(.cmd) 等の名前で置き、`which.ts` の探索 PATH をテスト時のみ引数で差し替えられるようにする（`resolveCli(cmd, pathOverride?)` — override は関数引数であり環境変数ではないので、CLI 実行経路からは注入できない）。

1. **値の経路テスト（最重要）**: MemoryVault に canary を保存 → engine で deploy → 偽 CLI が記録した stdin の内容が canary と一致し、engine の返す表示文字列・HandoffResult・例外のどこにも canary が現れない
2. **argv 不変条件**: 偽 CLI が受け取った argv に canary が含まれない。環境変数にも含まれない（偽 CLI 側で `process.env` をダンプして検査）
3. **スクラブ**: canary をそのまま echo する偽 CLI → `stdoutRedacted` が `***REDACTED***` を含み canary を含まない。7 文字の短い値 → 出力全体が withheld になる
4. **production 確認**: confirmProduction が false を返す → spawn されない（偽 CLI の記録ファイルが存在しない）・exit 相当の結果が declined。github target は env=development でも確認が呼ばれる
5. **dry-run**: spawn されない・値が読まれない（MemoryVault に読み出しカウンタを付けて 0 を確認）
6. **--force (vercel)**: preSteps の rm が本体より先に実行され、rm の stdin には何も書かれない
7. **CLI 不在**: resolveCli が見つけられない → manualSteps が表示され exit 5 相当
8. **プロセスレベル**: `deploy` の不正 NAME / 不正 target / 不正 env → exit 1。`deploy NAME --target cloudflare --env production` を非 TTY で → exit 4（keyring 到達前に確認段階で落ちるよう、確認を hasSecret より先に…とはしない。§3.2 の順序通り hasSecret が先なので、このテストは実 keyring に依存する → **e2e ゲート（AGENT_KEY_CASE_E2E=1）側に置く**）
9. **禁止識別子テスト**: 新規ファイル全部を対象に追加。さらに「`getPassword` の出現が `packages/core/vault/keyring.ts` と `packages/core/deploy/handoff.ts` の 2 ファイル以外に存在しない」ことを機械的に検査する assert を追加
10. 既存テスト（scan / vault）が全て green のまま

---

### 10.1 実装時の訂正（2026-07-03 実装・レビュー時に確認）

§10 冒頭の「MemoryVault に canary を保存 → engine で deploy」という記述は、§5.2 の不変条件（handoff.ts は `@napi-rs/keyring` の `Entry.getPassword()` を**このファイル内で直接**呼ぶ＝注入された `Vault` を経由しない）と矛盾する。`runWithSecret` に `MemoryVault` を渡しても、値の読み出し自体は常に実 OS ストアに対して行われるため、実行段階（`runWithSecret` が実際に spawn するケース）に到達するテストはすべて実ストアに触れる。

これは意図的な設計（値を読めるバックエンドを差し替え不能にする＝§2-9 の担保）なので、テスト戦略を実装時に以下へ修正した。**この修正は§2 の不変条件を弱めていない**（弱めていたら実装せず TODO を残すべき事項だったが、今回はテスト方法の是正のみ）。

- ゲート不要（`tests/run-tests.mjs` に実装済み・MemoryVault + 偽アダプタでインプロセス実行）: argv 不変条件、dry-run（spawn 0 回）、missing-secret、cli-unavailable、production/`github` の確認拒否（confirmProduction が false を返す限り spawn されない）、preStep 失敗時に本体（＝値の読み出し）へ到達しないこと。
- `AGENT_KEY_CASE_E2E=1` ゲート必須（`testDeployE2E` に実装済み・実 Windows Credential Manager + 偽 CLI フィクスチャ）: 値の経路（vault → 偽 CLI stdin 一致、argv/出力/例外に値が現れない）、echo された値のスクラブ、8文字未満の値の全体withhold、`--force` の preStep→本体の実行順序。
- 実アダプタ（cloudflare/vercel/github）経由のプロセスレベル `deploy` 統合テストは、対象 CLI のインストール・ログイン状態に環境依存するため実装していない。`targets --json` のプロセスレベルスモークテストと、`deploy` のバリデーション系（NAME/target/env 不正 → exit 1）のみプロセスレベルで検証する。

## 11. 受け入れチェックリスト（実装完了の定義）

- [ ] `npm test` 全件 green（新規テスト含む）
- [ ] §2 の不変条件 8〜14 をコードレビューで確認できる（特に: 値を保持するコードが handoff.ts に閉じている / `hasSecret` は boolean の存在確認だけ / production 確認に迂回フラグがない / allowlist が閉じた union）
- [ ] Windows 実機で `targets` が 3 社の検出・CLI 状態を正しく表示する
- [ ] 実アカウントで `deploy` → 各プラットフォームのダッシュボードに Secret が登録される（3社×1回、手動確認）
- [ ] `--dry-run` が値を読まずに計画だけ表示する
- [ ] production への deploy で "yes" を打たない限り実行されない
- [ ] CLI 未インストール環境で手動3ステップが表示される
- [ ] `npm pack` → クリーン環境で npx 実行が通る（prepack verify 有効のまま）
- [ ] README / SECURITY.md 更新、免責文が残っている

---

## 12. Phase 4 への引き継ぎメモ（本フェーズでは実装しない）

Phase 4（MCP）は CLAUDE.md §3.1 のツール群を MCP サーバーとして公開するが、実体はすべて本フェーズまでの core 関数の薄いラッパになる。engine を「TTY を知らない・確認をコールバックで受ける」構造にしてあるのはこのため。ただし **production 確認だけは MCP 経由で完結させてはならない**（エージェントが "yes" を自己供給できてしまう）——deploy_secret ツールは production 指定時に「CLI での対話実行を人間に依頼する」応答を返す設計が必要になる。詳細は Phase 4 の設計書で決める。

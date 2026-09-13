# Phase 2 Design — OS Secret Store Vault (save / check / list / remove)

> **履歴文書（2026-09-08整理）:** 以下はPhase 2時点の設計記録であり、現行CLIの実装指示ではない。
> 現行のAgent入力は`save --ask`、保存値の削除はHuman Plane必須で、`remove --yes`とstdin承認は廃止済み。
> コマンドは[README](../../README.md#secret-storage-save--check--list--remove)、境界は[SECURITY](../../SECURITY.md)、
> Agentの進行は[現行setup契約](agent-setup-readiness.md)を参照する。値の非公開・OS保管の原則は維持する。

> 対象読者: 実装を担当する AI エージェント（Sonnet / Codex クラス）および人間レビュアー。
> この文書は CLAUDE.md（リポジトリ直下）の下位文書である。**矛盾したら CLAUDE.md セクション3が常に勝つ。**
> フェーズごとに設計書を 1 枚ずつ置く。本書は Phase 2。Phase 3 以降は着手時に同ディレクトリへ追加する。

---

## 1. ゴールと非ゴール

### 1.1 ゴール

秘密の**値**を OS 標準シークレットストアに保存し、CLI からは「登録済み / 未登録」という**状態だけ**を扱えるようにする。

- `api-key-case save <NAME>` — 値を人間が対話入力（マスク表示なしの非エコー入力）→ OS ストアへ保存
- `api-key-case check [NAME]` — 登録済み / 未登録の状態のみ返す。NAME 省略時は scan の requiredSecrets 全件を照合
- `api-key-case list` — 保存済みキーの**名前とメタデータのみ**列挙（値は絶対に含めない）
- `api-key-case remove <NAME>` — 削除（確認プロンプトあり）
- スコープ: `user`（マシン全体）/ `project`（プロジェクトルート単位）。将来 `team` を1段足せる形にする（CLAUDE.md §1）

### 1.2 非ゴール（このフェーズでは実装しない）

- 値の読み出し・表示・エクスポート・.env への書き戻し（**恒久的に禁止**。CLAUDE.md §3.2）
- デプロイ（Phase 3）、MCP サーバー（Phase 4）、ライセンス（Phase 5）
- `team` スコープの実体（型に列挙だけしておく）
- keyring が使えない環境向けのネイティブコマンド・フォールバック実装（§4.4 の TODO 参照）

---

## 2. セキュリティ不変条件（実装中に一つでも破ったら手を止めて TODO を残すこと）

1. **値は次の経路にしか存在してはならない**: 人間のキーボード入力 → プロセスメモリ上のローカル変数 → OS シークレットストア API 呼び出し。
2. 値を stdout / stderr / ログ / 例外メッセージ / JSON 出力 / メタデータ index ファイルに**含めない**。エラー時も同様（例外を re-throw する際にメッセージへ値を混ぜない）。
3. 値をコマンドライン引数・環境変数で**受け取らない**。`save NAME VALUE` の形で余分な位置引数が来たら保存せずエラーにし、「シェル履歴に残った可能性があるためキーのローテーションを推奨する」旨を表示する。
4. 値の入力は **TTY 必須**。stdin がパイプ/リダイレクトの場合は拒否する（AI エージェントがプログラム的に値を流し込む経路を塞ぐ）。
5. CLAUDE.md §3.2 の禁止関数名（`get_secret` / `print_secret` / `show_raw_value` / `export_all_secrets` / `write_secret_to_env` / `send_secret_to_url`）を**識別子としてもコメントとしても新規ソースに書かない**（既存テスト `testSourceDoesNotExposeDangerousHelpers` の検査対象に新規ファイルを追加する）。
6. `Vault` インターフェースに「値を返すメソッド」を**定義しない**。存在チェックの内部実装が値の読み取りを伴う場合（§4.3）、読んだ値はローカル変数に留め、boolean へ変換したら直ちに参照を捨てる。テンプレートリテラルへの埋め込み・オブジェクトへの格納・return を禁止。
7. メタデータ index（§6）に保存してよいのは: キー名 / スコープ / projectId / プロジェクトパス / タイムスタンプのみ。**値・値のハッシュ・値の長さも保存しない**（長さも情報漏洩になる）。

---

## 3. CLI 仕様

既存の `packages/cli/index.ts` の `parseArgs` / `main` 分岐スタイルを踏襲する。出力言語は既存に合わせて**英語**。

### 3.1 コマンド一覧

```
api-key-case save <NAME>   [--scope user|project] [--force]
api-key-case check [NAME]  [--scope user|project] [--json] [--strict] [path]
api-key-case list          [--scope user|project] [--json] [path]
api-key-case remove <NAME> [--scope user|project] [--yes]
```

- `--scope` 省略時のデフォルトは `project`。
- `path` は `check`（NAME 省略時の scan 連携）と `list` で対象プロジェクトルートを指定する。省略時 `process.cwd()`。
- `save --force`: 既に登録済みの NAME を上書きする場合に必須。`--force` なしで既存 NAME に save したら上書きせず `NG: <NAME> already exists (use --force to overwrite)` を出して exit 1。
- `remove --yes`: 確認プロンプトをスキップ。省略時は `Remove <NAME> (project scope)? [y/N]` を TTY で確認。非 TTY かつ `--yes` なしなら exit 1。

### 3.2 NAME のバリデーション

- 正規表現 `^[A-Z][A-Z0-9_]{0,127}$` に一致しなければ exit 1（scan の .env.example 生成規則と揃える）。

### 3.3 出力仕様（状態のみ。CLAUDE.md §3.1 の返り値契約）

テキスト出力例:

```
OK: OPENAI_API_KEY saved to project scope.
OK: OPENAI_API_KEY is registered (project scope).
NG: PADDLE_API_KEY is not registered.
OK: OPENAI_API_KEY removed from project scope.
```

`check`（NAME 省略・scan 連携）のテキスト出力例:

```
Required secrets (from scan):
  OK  OPENAI_API_KEY   registered (project)
  NG  PADDLE_API_KEY   missing
  NG  RESEND_API_KEY   missing

2 missing. Run: api-key-case save <NAME>
```

`check --json` の出力スキーマ（値は構造上入り得ない）:

```json
{
  "scope": "project",
  "projectId": "a1b2c3d4e5f60718",
  "secrets": [
    { "name": "OPENAI_API_KEY", "status": "registered" },
    { "name": "PADDLE_API_KEY", "status": "missing" }
  ],
  "missingCount": 1,
  "backend": "keyring"
}
```

`list --json`:

```json
{
  "scope": "project",
  "entries": [
    { "name": "OPENAI_API_KEY", "scope": "project", "updatedAt": "2026-07-02T00:00:00.000Z", "storeStatus": "registered" }
  ]
}
```

`storeStatus` は index と実ストアの突合結果: `registered` | `stale`（index にあるがストアに無い）。

### 3.4 終了コード

| code | 意味 |
|---|---|
| 0 | 成功（`check` で missing があっても `--strict` なしなら 0） |
| 1 | 一般エラー（バリデーション・上書き拒否・確認拒否・非 TTY での save 等） |
| 2 | `check --strict` で missing が 1 件以上 |
| 3 | vault バックエンド利用不可（§4.4） |

### 3.5 ヘルプ

`printHelp()` に上記4コマンドを追記。既存の "Security boundary" 節に次の一文を追加:

```
  Secret values are typed by a human, stored in the OS secret store,
  and never printed, exported, or written to files by this CLI.
```

---

## 4. Vault 抽象

### 4.1 ファイル構成（新規）

```
packages/core/vault/types.ts     // SecretRef, SecretScope, Vault interface, エラー型
packages/core/vault/naming.ts    // service/account 文字列と projectId の導出
packages/core/vault/keyring.ts   // KeyringVault (@napi-rs/keyring)
packages/core/vault/memory.ts    // MemoryVault（テスト専用・インプロセス）
packages/core/vault/registry.ts  // メタデータ index の読み書き
packages/core/vault/index.ts     // createVault() ファクトリ + 高レベル操作
packages/cli/prompt.ts           // 非エコー対話入力・確認プロンプト
```

### 4.2 型定義（types.ts）

```ts
export type SecretScope = "user" | "project"; // NOTE: "team" is a planned future scope; do not implement.

export interface SecretRef {
  name: string;          // validated: ^[A-Z][A-Z0-9_]{0,127}$
  scope: SecretScope;
  projectId: string | null; // null when scope === "user"
}

// Deliberately has NO method that returns a secret value. Do not add one.
export interface Vault {
  readonly backendName: string;
  isAvailable(): Promise<boolean>;
  setSecret(ref: SecretRef, value: string): Promise<void>;
  hasSecret(ref: SecretRef): Promise<boolean>;
  deleteSecret(ref: SecretRef): Promise<boolean>; // true = deleted; false = absent
}

export class VaultUnavailableError extends Error {}
export class SecretNameError extends Error {}
```

### 4.3 KeyringVault（keyring.ts）

- 依存: **`@napi-rs/keyring` 2.0.0 以降**（napi-rs チームがメンテ。プラットフォーム別プリビルドが optionalDependencies で配布され node-gyp 不要 → 「npx 一発」の要件に適合）。メジャーバージョンを固定して dependencies に追加する。
- macOS Keychain / Windows Credential Manager / Linux libsecret(Secret Service) を単一 API で吸収する。
- 使い方: `new Entry(service, account)` に対し `setPassword(value)` / `getPassword()` / `deleteCredential()`。
- **2.0.0 の戻り値契約**: 未登録エントリの `getPassword()` は `null`、`deleteCredential()` は `false`。credential store の read failure と、存在する credential の delete failure は例外を投げる。したがって `false` は absent の意味だけに使い、存在確認後の `false` を成功や stale index として扱わない。
- `hasSecret` の実装: `entry.getPassword() !== null` を**一つの式で** boolean 化する（値を変数・オブジェクト・テンプレートリテラルに置かない。§2-6）。予期しない例外は、メッセージに値が含まれていないか確認してから re-throw（含まれる場合は差し替える）。
- `isAvailable`: プローブ用エントリ（`account = "v1|probe"`）への set → delete を try し、失敗したら false。Linux で Secret Service（gnome-keyring 等）が無いヘッドレス環境では false になる想定。

### 4.4 バックエンド利用不可時の挙動

`createVault()` が `isAvailable() === false` を検出したら、**exit 3** で以下のような案内を出して終了する（値の代替保存先を勝手に作らない）:

```
NG: no OS secret store is available on this system.
    macOS: Keychain should be available by default.
    Windows: Credential Manager should be available by default.
    Linux: install and unlock a Secret Service provider (e.g. gnome-keyring).
```

> TODO（実装しない・緩和しない）: 平文ファイルへのフォールバックは CLAUDE.md §3-2 違反なので**作らない**。
> ネイティブコマンド（`security` / `secret-tool` / PowerShell CredRead）による代替バックエンドは Phase 2.5 候補として保留。

### 4.5 MemoryVault（memory.ts）

`Map<string, string>` によるインプロセス実装。**テスト専用**。CLI からは選択不可にする（環境変数等でバックエンドを切り替えるフックを CLI に作らない — 切替フックは「値がどこに行くか」を攻撃者が曲げる口になるため）。テストは dist から直接 import して使う。

---

## 5. 命名スキーム（naming.ts）

OS ストア上の識別子:

- `service` = 固定文字列 `"api-key-case"`
- `account` = `"v1|" + scope + "|" + scopeId + "|" + name`
  - user スコープ: `scopeId = "-"` → 例 `v1|user|-|OPENAI_API_KEY`
  - project スコープ: `scopeId = projectId` → 例 `v1|project|a1b2c3d4e5f60718|OPENAI_API_KEY`

`projectId` の導出（決定的であること）:

1. プロジェクトルート = 対象ディレクトリの `fs.realpathSync()`
2. 正規化: バックスラッシュ→スラッシュ、小文字化（Windows のケース非依存対策）
3. `sha256(normalizedPath)` の hex 先頭 16 文字

git remote 由来の ID は「remote 未設定の初心者プロジェクト」で破綻するため採用しない。パスを移動すると projectId が変わる制約は既知とし、`list` の `stale` 表示（§3.3）で気付けるようにする。

---

## 6. メタデータ index（registry.ts）

OS ストアはクロスプラットフォームで列挙 API が安定しないため、`list` 用に**値を含まない** index を持つ。

- 置き場所: `os.homedir()/.api-key-case/index.json`（ディレクトリが無ければ作成。POSIX では `chmod 0o600` を設定、Windows は既定 ACL のまま）
- `registry.ts` の各関数は省略可能な `baseDir` 引数を持つ（デフォルト `os.homedir()`）。**テスト専用**: `npm test` が実ユーザーの index.json を汚さないためのフックであり、CLI フラグ・環境変数として**露出させない**（露出させると書き込み先を外部から曲げる口になる）。index は値を含まないため §4.5 のバックエンド切替禁止とは性質が異なり、この限定的な DI は許容する。
- スキーマ:

```json
{
  "version": 1,
  "entries": [
    {
      "name": "OPENAI_API_KEY",
      "scope": "project",
      "projectId": "a1b2c3d4e5f60718",
      "projectPath": "c:/users/example/projects/keycase",
      "createdAt": "2026-07-02T00:00:00.000Z",
      "updatedAt": "2026-07-02T00:00:00.000Z"
    }
  ]
}
```

- 整合性の原則: **真実は常に OS ストア側**。`check` は必ずストアを照合する（index は見ない）。index は `list` の表示専用。save/remove 成功時に index を更新し、破損 JSON は警告を出して空として扱う（クラッシュさせない）。
- `projectPath` は表示用の利便情報。秘密ではないが、`--json` 出力に含めるのは `list` のみとする。

---

## 7. 対話入力（packages/cli/prompt.ts）

```ts
// DI-friendly: accepts streams so tests can inject fakes.
export async function promptSecretValue(
  label: string,
  stdin?: NodeJS.ReadStream,
  stdout?: NodeJS.WriteStream
): Promise<string>;

export async function confirm(question: string, ...): Promise<boolean>;
```

仕様:

- `stdin.isTTY` でない場合は即座に throw（CLI 側で exit 1 + `NG: secret input requires an interactive terminal.`）。
- raw mode で 1 文字ずつ読み、**エコーしない**（`*` も出さない — 文字数すら画面に残さないため）。プロンプトは `Enter value for OPENAI_API_KEY (input is hidden): `。
- Enter で確定。Backspace 対応。Ctrl+C は入力を破棄して exit 1。
- バリデーション: 空文字は再入力を促す（3回で諦めて exit 1）。前後の空白と改行のみ trim。長さ上限 4096。改行を含む値は不可。
- 確認のための再入力は行わない（打鍵回数を優先。typo は `--force` で上書きすれば済む）。
- 入力完了後、受け取った文字列は保存処理に渡す以外の用途に使わない。

---

## 8. 既存コードへの変更

- `packages/cli/index.ts`: `parseArgs` を command ごとのオプション解釈に対応させる（既存 scan の挙動・フラグは**一切変えない**）。`save`/`check`/`list`/`remove` の分岐を追加。vault 操作は `packages/core/vault/index.ts` の高レベル関数（`saveSecretInteractive` 等ではなく、CLI 側でプロンプト→`vault.setSecret` を組む。core は端末入出力を知らない構造を守る）。
- `check`（NAME 省略時）: 既存 `scanProject()` を `{ targetDir }` のみで呼び、`report.requiredSecrets` を突合に使う。scan 側の変更は不要。
- `package.json`: `@napi-rs/keyring` を dependencies に追加。`files` 配列は変更不要（dist に含まれる）。version を `0.3.0` に上げる。
- `README.md` / `SECURITY.md`: 新コマンドと「値の経路」（§2-1）を追記。**免責文**（「完全な安全は保証しない。事故確率を下げるツール」）を README に必ず残す。

---

## 9. テスト計画（tests/run-tests.mjs に追加）

canary 方式（既存の `assertNoCanary` を再利用）を軸にする。

1. **MemoryVault 単体**（dist import・インプロセス）
   - set → has=true / delete → has=false / 未登録 has=false
   - scope と projectId が違えば別エントリになる（user と project の分離、プロジェクトA/Bの分離）
2. **naming 単体**: projectId が「大文字小文字・スラッシュ向きの違うパス表記」で同一値になる。NAME バリデーションの境界（小文字始まり・129文字・記号で reject）
3. **registry 単体**: index 更新・破損 JSON 耐性・**index ファイル内容に canary が現れない**
4. **CLI 境界テスト**（spawnSync）:
   - `save NAME` に stdin をパイプで canary を流す → **exit 1、ストアにも index にも canary が残らない**、stdout/stderr に canary なし
   - `save NAME <canary>` と位置引数で値を渡す → exit 1、ローテーション推奨文言、canary は保存されない
   - `check UNKNOWN_KEY` → `NG:` + exit 0、`check --strict` → exit 2
   - 不正 NAME → exit 1
5. **禁止識別子テスト**: `testSourceDoesNotExposeDangerousHelpers` の対象に `packages/core/vault/*.ts` と `packages/cli/prompt.ts` を追加
6. **実ストア e2e（任意・ゲート付き）**: 環境変数 `AGENT_KEY_CASE_E2E=1` のときのみ、実 keyring に `AKC_E2E_TEST_KEY` を save/check/remove して必ず後片付けする。CI 既定では実行しない（Linux ヘッドレスで落ちるため）
7. 既存テストが全て green のまま（scan への回帰なし）

---

## 10. 受け入れチェックリスト（実装完了の定義）

- [ ] `npm test` が全件 green（新規テスト含む）
- [ ] §2 の不変条件 1〜7 をコードレビューで確認できる（特に: 値を返すメソッドが `Vault` に存在しない）
- [ ] Windows 実機で `save` → `check` → `list` → `remove` が動作し、Credential Manager の GUI にエントリが見える
- [ ] 非 TTY での `save` が拒否される
- [ ] `api-key-case check --json` の出力に値が構造上含まれない（スキーマ §3.3）
- [ ] `npm pack` → クリーンディレクトリで `npx` 実行が通る（prepack の verify が有効なまま）
- [ ] README / SECURITY.md 更新、免責文が残っている

---

## 11. Phase 3 への引き継ぎメモ（本フェーズでは実装しない）

Phase 3（デプロイ代行）は「OS ストア → 公式 CLI の stdin」への値の直接受け渡しが必要になる。そのために core 内部限定・CLI/MCP 非公開の受け渡し機構（例: 子プロセスの stdin へ書き込むだけで値を return しない関数）を設計することになるが、**その設計判断は Phase 3 の設計書で行う**。Phase 2 では読み出し経路を一切作らないこと。

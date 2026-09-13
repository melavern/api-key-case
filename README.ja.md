# API Key Case（日本語）

> English README: **[README.md](README.md)**
>
> このページは日本語話者向けの入口です。コマンドの全一覧・終了コード・MCPの設定・開発者向け手順・
> 各プラットフォームの詳細な挙動は英語READMEが正本で、こちらには要約とリンクだけを置いています。
> 内容が食い違った場合は英語READMEを正とします。

**APIキーの現物をAIに渡さず、「作業」だけを渡すためのローカルCLIです。**
プロジェクトをローカルでスキャンし、シークレットの扱いに関するリスクを報告し、Claude Code / Codex /
Cursor などのAIコーディングエージェントに渡せる伏字済みのコンテキストを生成します。値の保管はOSの
シークレットストア。Pro機能の `deploy` は、保管済みの値を各社の公式CLI経由で Cloudflare / Vercel /
GitHub へ配置します。**シークレットの値そのものが返される・表示される・ログに出ることはありません。**

> **アルファ版です。** 完全な安全は保証しません。事故の確率を下げるためのツールです。
> 生成物はAIや外部サービスへ渡す前に、必ずご自身で確認してください。
>
> 現在は v1.0 前のプレリリースです。最新の状況は英語READMEの
> [Status and roadmap](README.md#status-and-roadmap) を参照してください。

**[製品サイト](https://apikeycase.melavern.com/)** · **[セキュリティ](SECURITY.md)** · **[サポート](SUPPORT.md)** · **[利用規約](https://apikeycase.melavern.com/terms)** · **[プライバシー](https://apikeycase.melavern.com/privacy)** · **[特商法表記](https://apikeycase.melavern.com/tokushoho)** · **[ブランド・第三者素材のNOTICE](NOTICE)**

Leone Apps は Melavern に名称変更しました。今回の更新はブランド移行のみで、npmの新バージョン公開やMITライセンス条件の変更はありません。公開済み `api-key-case@0.9.0` は変更されず、埋め込み済みの旧ライセンス交換先を利用します。このソースからのbuildはMelavernの交換先を利用します。既存の0.9.0デモ録画には、当時のブランド表記が残る場合があります。

## クイックスタート

Windows / macOS / Linux の Node.js 20 以降が必要です。

```sh
# 現在のプロジェクトをローカルでスキャンする。実際の .env の中身は読みません。
npx -y api-key-case@latest scan .

# AIコーディングエージェント向けに、伏字済みのコンテキストを生成する。
npx -y api-key-case@latest scan . --agent-report

# 値を隠し入力のプロンプトから保存する。
npx -y api-key-case@latest save OPENAI_API_KEY

# 状態だけを確認する。値が返ることはありません。
npx -y api-key-case@latest check OPENAI_API_KEY
```

実際のシークレットを、コマンドの引数・Issue・チャット・生成されたレポートに書かないでください。
`save` が値を隠しプロンプトからしか受け取らないのは、この事故を防ぐための意図的な制限です。

## デモ

[![API Key Case デモ](https://apikeycase.melavern.com/demo-ja-poster.jpg)](https://apikeycase.melavern.com/demo-ja.mp4)

**[日本語版を見る](https://apikeycase.melavern.com/demo-ja.mp4)**（テロップ・BGMあり、CLI出力は英語）/
**[英語版を見る](https://apikeycase.melavern.com/demo.mp4)**（ナレーションなし）

`scan` がコミット済みの `.env` とハードコードされたキーを検出し、`save` が隠しプロンプトで値を保管し、
`check` が状態だけを報告し、Pro の `deploy` が保管済みの値を `wrangler` に渡すまでを収録しています。
映っているターミナルの出力はすべてこのリポジトリのCLIの実行結果で、シークレットの値は一度も現れません。

## できること

- `.env` と `.env.*` が ignore されているかを確認する
- env ファイルが現在または過去にGitで追跡されていないかを、ネストしたファイルも含めて検出する
- `.env.example` とコード中の参照から、必要な環境変数名を洗い出す
- シークレットらしき値を、元の行や値そのものを再現せずに報告する
- 値が空の `.env.example` を生成する
- AIエージェント向けに `AGENT_CONTEXT.safe.md` と `AI_SAFE_PROMPT.md` を生成する
- JSON出力と、CI向けの厳格な終了コードに対応する
- 値をOSのシークレットストア（Keychain / 資格情報マネージャー / libsecret）に保管し、
  登録済みか未登録かだけを報告する（値そのものは決して返さない）

スキャナは実際の `.env` の中身を読まず、ネットワーク通信も行いません。

## やらないこと

- **APIキーの取得は代行しません。** Cloudflare や Vercel や OpenAI にログインして
  資格情報を取ってくる・発行するような連携はありません。値は提供元から自分で取得し、一度だけ入力します
- **`wrangler` / `vercel` / `gh` の置き換えではありません。** `deploy` は、すでにインストール・
  ログイン済みの本物のCLIを実行します。無い場合は、勝手に入れたり迂回したりせず手順を表示します
- **`production`（およびGitHub）への配置を、あなたの代わりに承認しません。**
  スクリプトからもエージェントからも同じです。この確認を飛ばすフラグ・環境変数・MCP経路はありません
- **シークレットが漏れないことを保証しません。** 実際に何を守り何を守れないかは
  [セキュリティモデルと限界](#セキュリティモデルと限界) を参照してください

## シークレットの保管（`save` / `check` / `list` / `remove`）

`check` / `hasSecret` は、OSシークレットストアの読み取り結果を直ちに真偽値へ畳み、値を返却・保存・
記録しません。保存時の経路は **対話的な非エコーのプロンプトで入力 → ローカルのプロセスメモリ上に留まる
→ OSのシークレットストアへ書き込まれる** だけです。`deploy` のときだけ、配置先CLIの標準入力へ渡す間に
値を一時的に保持します。CLIの画面・ログ・AI向け応答へ値を出すことはありません。コマンドライン引数やパイプ経由のstdinからの入力は拒否します
（どちらもシェル履歴やプロセスログに痕跡を残すためです）。

```sh
api-key-case save OPENAI_API_KEY          # 値を入力（隠し入力、TTY必須）
api-key-case check                        # scan が参照する全シークレットの状態
api-key-case check OPENAI_API_KEY --json  # 個別の状態
api-key-case list                         # 名前とメタデータのみ。値は決して出ません
api-key-case remove OPENAI_API_KEY        # OSシークレットストアから削除（確認あり）
```

主なオプション: `--scope user|project`（既定は `project`）、`--force`（`save` の上書き）、
`--yes`（`remove` の確認スキップ）、`--json`、`--strict`。

終了コード `3` は、このシステムで利用できるOSシークレットストアが無いことを意味します
（Secret Service が動いていないヘッドレスのLinuxなど）。

## 配置（`deploy` / `targets`）— Pro機能

`deploy` は、`save` で保管済みの値を、各社の**公式CLI**（`wrangler` / `vercel` / `gh`）を通じて
Cloudflare / Vercel / GitHub へ渡します。APIを直接叩くことはしません。値の経路は
「OSシークレットストア → このCLIが一度だけ読む → 対象CLIのstdinへ書く → 破棄」だけです。
値がコマンドライン引数・環境変数・一時ファイル・ログ行に置かれることはなく、対象CLIの出力は
表示される前に値が除去されます。

```sh
api-key-case targets                                     # 何が検出され、各CLIは導入済み・ログイン済みか
api-key-case deploy OPENAI_API_KEY --target cloudflare    # 既定は development
api-key-case deploy OPENAI_API_KEY --target vercel --env preview
api-key-case deploy OPENAI_API_KEY --target cloudflare --env production --dry-run
```

`production` への配置、および **github へのすべての配置**は、計画を表示したうえで `yes` の入力を
求めます。これを飛ばすフラグはありません。非対話で実行したい場合は、スクリプトやエージェントからではなく、
人間がターミナルで実行してください。

### 渡したあと、値がどう扱われるか

手を離れた値は、このツールではなく各プラットフォームのルールの下に置かれます。とくに次の2点は
知らないと事故になります。

- **GitHub は `--env` によって作られるものが変わります。** `development`（既定）は
  **repository secret** で、そのリポジトリの全workflowから使えます。`production` / `preview` は
  **environment secret** で、`environment:` を宣言したjobだけが読めます。
  つまりGitHubでは**既定の `development` が最も広いスコープ**になり、名前の印象と逆です。
- **Vercel の `development` は sensitive にできません。** Vercel のAPIの制約により、
  プロジェクトにアクセスできる人は `vercel env pull` で値を読み戻せます。
  読み戻されたくない値を `development` に置かないでください。

Cloudflare を含む3社の詳細な挙動は、英語READMEの
[What each platform does with the value after that](README.md#what-each-platform-does-with-the-value-after-that)
を参照してください。

## 価格とライセンス

現在の `scan` / `save` / `check` / `list` / `remove` / `targets` と、`deploy_secret` を除くMCP機能は
**¥0** です。`deploy` は Lemon Squeezy での**買い切り ¥2,980**（サブスクリプションではありません）で
解放されます。購入には現在のプレリリースと、**Pro v1（1.x系）の範囲**のアップデートが含まれます。
将来のメジャーバージョンは別ライセンスになる場合があります。

| 機能 | Free | Pro |
| --- | :---: | :---: |
| ローカルスキャンと伏字済みエージェントレポート | ✓ | ✓ |
| OSシークレットストア（`save` / `check` / `list` / `remove`） | ✓ | ✓ |
| 配置先の診断とMCPサーバー（任意） | ✓ | ✓ |
| Cloudflare / Vercel / GitHub への `deploy` | — | ✓ |

1購入は1名分で、その方ご自身の端末とプロジェクトで使えます。組織で使う場合は利用者ごとに1購入が必要です。
返金は[返金ポリシー](https://apikeycase.melavern.com/refund)に基づき14日以内で受け付けます。
[利用規約](https://apikeycase.melavern.com/terms)は公式のPro権利とサービスに適用されるもので、
MITライセンスがソースコードに与える権利を狭めるものではありません。

```sh
api-key-case license activate     # 隠し入力での対話式。argvと非TTY入力は拒否されます
api-key-case license status [--json]
api-key-case license deactivate
```

購入すると Lemon Squeezy から購入キーがメールで届きます。`license activate` はそのキーを一度だけ
HTTPSで交換用Workerへ送り、Worker側で Lemon のライセンス・店舗/製品/バリアント・支払い済みかつ
未返金であることを検証したうえで、Ed25519署名済みの `AKC1` ライセンスを返します。以降のPro判定は
**完全にローカル・オフライン**で、テレメトリも端末紐付けも定期再検証も有効期限もありません。

本プロジェクトはMITのオープンソースであり、DRMではありません。ブランドと第三者素材の境界は[NOTICE](NOTICE)に、ライセンスは開発継続を支えるための
善意のゲートであって、フォークを技術的に防ぐものではありません。設計と脅威モデルの全体は
[docs/design/phase-5-license.md](docs/design/phase-5-license.md) を参照してください。

## 動作要件

- Node.js 20 以降
- 追跡状況と履歴の確認のため、Git の導入を推奨します

## セキュリティモデルと限界

正本は **[SECURITY.md](SECURITY.md)**（英語）です。とくに重要な点を抜き出すと:

- 検出結果は `***REDACTED***` で表示され、元の行や部分的な値は出しません
- 実際のenvファイルは、中身ではなくファイル名とGitの状態で判定します
- **トークン検出はヒューリスティックです。** 既知の鍵の形の閉じた集合にのみ一致し、特定の拡張子の
  テキストファイルだけを走査します（`node_modules` / `dist` / ビルド成果物 / 1MB超のファイルは除外）。
  クリーンな結果は「明らかなものは見つからなかった」であって「何も無い」ではありません
- Git履歴の確認が見るのはenvのファイル名で、過去のすべてのシークレット値ではありません
- GitHub secret scanning / Gitleaks / TruffleHog / シークレットマネージャー / 鍵のローテーションの
  代替にはなりません
- `deploy` が値を公式CLIのstdinへ渡した後、その値は各CLIのプロセス内にあり、
  そのログや挙動に従います。出力の除去が守るのはこのCLIに戻ってくる範囲だけです
- OSシークレットストアのUI（キーチェーンアクセスや資格情報マネージャー）から人が値を読み出して、
  自分でチャットやチケットに貼ることは止められません。このツールが閉じるのは、自身が制御する経路だけです
- **実際の資格情報がコミットされた・露出した場合、提供元でローテーションすることだけが露出を取り消します。**
  スキャンがクリーンになることも、ファイルを削除することも、それ自体では不十分です

## さらに詳しく（英語ドキュメント）

| 知りたいこと | 参照先 |
| --- | --- |
| コマンドとオプションの全一覧 | [Commands](README.md#commands) |
| 終了コードの一覧 | [Exit codes](README.md#exit-codes) |
| エージェントレポートの中身 | [Agent report](README.md#agent-report) |
| MCPサーバーの設定（Claude Code / Cursor） | [MCP server](README.md#mcp-server-optional-for-agents) |
| 配置先ごとの詳細な挙動 | [What each platform does](README.md#what-each-platform-does-with-the-value-after-that) |
| セキュリティ境界の全体像 | [SECURITY.md](SECURITY.md) |
| 開発・ビルド手順 | [Development checkout](README.md#development-checkout) |
| 今後の予定 | [Status and roadmap](README.md#status-and-roadmap) |

## ライセンス

MIT。`deploy` を含む全ソースが公開されています。`deploy` の実行には追加で買い切りのライセンスキーが
必要ですが（[価格とライセンス](#価格とライセンス)）、これはコード自体への技術的な制限ではなく
善意のゲートです。

サポートと貢献について: [SUPPORT.md](SUPPORT.md) ·
[CONTRIBUTING.md](https://github.com/melavern/api-key-case/blob/main/CONTRIBUTING.md)

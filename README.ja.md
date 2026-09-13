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

> **本書はv0.9.1プレスタブル版のAgent-first導線を説明します。** `@latest`はnpmの公開dist-tagに従うため、段階的な公開中は遅れて切り替わる場合があります。検証・購入前にexact versionの`0.9.1`がnpmで利用可能か確認し、受入証跡と公開gateは[リリースチェックリスト](docs/RELEASING.md)を参照してください。
>
> 完全な安全は保証しません。事故の確率を下げるためのツールです。
> 生成物はAIや外部サービスへ渡す前に、必ずご自身で確認してください。

**[製品サイト](https://apikeycase.melavern.com/)** · **[OS対応状況](https://apikeycase.melavern.com/os-support)** · **[npm](https://www.npmjs.com/package/api-key-case)** · **[変更履歴](CHANGELOG.md)** · **[セキュリティ](SECURITY.md)** · **[サポート](SUPPORT.md)** · **[利用規約](https://apikeycase.melavern.com/terms)** · **[プライバシー](https://apikeycase.melavern.com/privacy)** · **[特商法表記](https://apikeycase.melavern.com/tokushoho)** · **[ブランド・第三者素材のNOTICE](NOTICE)**

## クイックスタート

Agent-firstの通常対応の基準はWindows 11 + Windows Helloです。
macOSは協力検証版です。実装、最新CI、実Keychain連携は確認済みですが、実機GUIでの承認、
Accessibility経由の自動操作への耐性、Intel実機、実Macからの配置は未確認です。
macOSではProの配置機能を実機検証中です。購入はできますが、現時点では正常な動作を保証していません。
[OS対応状況](https://apikeycase.melavern.com/os-support)と
[macOSの現状・検証計画](docs/design/macos-human-plane-verification.md)に、確認済み・未確認をまとめています。

Windows / macOS / Linux の Node.js 20 以降が必要です。Windowsのhigh-risk approval、`remove`、
`trust forget`は、**Windows 11 Build 22000以降 かつ そのアカウントにWindows Hello（PIN・指紋・顔）が
設定済み**であることが必要です。Windows 10やHello未設定のアカウントでは該当判断だけをfail closedして
人間へhandoffし、scan・vault・Secret inputは引き続き利用できます。`deploy`は有料機能なので、
購入前にこの条件を確認してください。LinuxではOSストアが利用可能なら無料診断・状態確認・履歴と、
人が所有する端末からの保存・確認・一覧が利用できますが、Agent-firstの入力・承認・配置実行、承認を要する
保存値・配置先の信頼の削除は提供していません。保管方式と再ログイン・再起動後の永続性には環境ごとの確認事項があります。

公開済み版の基本コマンドは、次のように試せます。

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
人が所有するterminalでは従来の隠しプロンプトを使います。Agent-firstでは`save --ask`を要求し、
Human Planeのダイアログ以外へ値を入力しないでください。

### 今の `.env` から始める

すでに使っているキーも、Agentに`.env`本文を読ませず登録できます。必要なSecret名だけを確認し、
`.env`は人間自身が開いて、値だけをHuman Planeへコピーしてください。一括で自動的に取り込む機能ではなく、
元の`.env`を削除・同期・置換・変更しません。必要なら従来どおり使えます。登録だけで作業を終えてよく、
deployは別の操作です。

scannerが現在扱うのは`.env.example`と、主にJavaScript / TypeScriptの一般的な参照です。
未対応の言語・構文で名前を検出できなくても「不要」という意味ではありません。Secret名が分かれば直接
保存・確認できます。また保管先にはdeploy環境の区別がないため、同じproject/nameへdevelopment用と
production用の別々の値を同時には保持できません。登録する1つを選び、既存値を意図せず上書きしないでください。

deployにはproviderとproject構成ごとの追加条件があります。特にCloudflareでは、Wrangler projectに実体のある
`.env` / `.env.*`（`.env.example`を除く）/ `.dev.vars` / `.dev.vars.*`が共存すると、Wranglerがそれらを読み得るため、API Key Case側の
安全条件でAgent-first deployを停止します。ログイン不足やFreeプランが原因という意味ではなく、Secretの登録自体は
可能です。API Key Caseは元ファイルを変更しません。Pro購入前に無料のreadiness診断で確認してください。

## Agent Control Plane / Human Plane（Phase A/B/C/D/E）

以下はv0.9.1の機能です。利用前に`npx -y api-key-case@0.9.1 --version`が`0.9.1`を返すことを
確認してください。npmにexact versionがまだ無い段階では、[公開前の検証手順](docs/RELEASING.md#testing-the-candidate-before-publication)に従って候補版tarballを使います。

```sh
api-key-case agent-init .          # 現sessionのprotocolを返し、既存host instructionを管理
api-key-case agent-init . --check  # 書き込まずdrift / symlink安全性を検査
api-key-case agent-init . --host agents # 新規projectへAGENTS.mdを明示的に作成
api-key-case next --json .         # semanticな状態とnextActionsをclosed schemaで返す
api-key-case save OPENAI_API_KEY --ask # Windows / macOSの専用入力画面
api-key-case history --json .      # 無料: 過去の配置結果。現在の値は未確認
```

`agent-init`はmanaged block外の既存内容を保ち、project内だけへ書き、symlink / junctionを拒否します。
global設定やMCP設定は変更しません。persistent instructionは`@latest`やmajor系列へのfloating pinではなく、
`agent-init`を実行したexact version（例: `api-key-case@0.9.1`）へpinします。これにより明示的に
`agent-init`を再実行するまで、後続のpre-stable minor releaseが既存repositoryのAgent protocolを変更しません。

`next --json`には自由な`command` / `argv`経路がなく、Secret値・部分値・値由来hash・lengthを返しません。
schema 2では、普段使っているCoding Agentが人へ説明するための無料診断と作業の要約を追加しています。
`setup.stage` / `setup.counts`は登録済み・不足・要確認の件数と作業段階、`host`は入力と承認の利用条件、
各targetの`readiness`は環境ごとの配置準備を表します。購入前でも実配置と同じ配置先・CLIの確認処理を使い、
Secretの配置や承認は行いません。利用条件と`license.plan`は別なので、購入しても解消しない条件を先に案内できます。
`prerequisites-checked`でも、人間の画面操作とprovider側の書き込み権限は未確認です。
保存済みは配置済みを意味せず、`setup.deploymentState`は`not-inspected`のままです。

新しいチャットや配置作業の再開時には、Agentが無料の`history --json`も読み、過去の操作を
完了・未完・不明として説明します。現在の配置値は常に未確認です。`--force`の失敗では
削除だけ済んでいる可能性があり、中断や結果の保存失敗は不明のままです。登録の更新日時が
変われば表示しますが、日時や配置先が一致しても値の同一性は証明しません。
履歴は承認・trust・自動再配置・自動再試行の根拠にはしません。

履歴は`~/.api-key-case/deployment-history/`へprojectごとに直近200操作を保存します。
名前・scope・配置先識別情報・環境・日時・結果だけで、秘密値・部分値・値由来のhashや長さ・
provider出力は含みません。配置処理が動いていないことを確認してから、このディレクトリ全体
または該当projectのサブディレクトリを明示的に削除できます。Secret本体とtrustは別です。
履歴が無い／読めない場合は不明です。開始記録の保存失敗では配置前に停止し、配置後の結果保存
だけが失敗した場合は実際の配置結果と警告を返します。再実行せず残りの作業を確認します。
履歴レポートschema 2は、履歴ファイルが無い場合と、ロック・内容不正・アクセス拒否などを
閉じた原因コードと復旧案内で区別します。ロックだけで異常終了とは断定せず、処理中かを
確認します。読めても書き込めるとは判定しません。開始記録の失敗は「今回の配置は未実行」、
結果保存の失敗は「実際の配置結果を維持」と分け、原因への対応後にまず履歴を再確認します。
履歴の破棄や新たな配置は明示的に判断し、既存ロック・履歴を自動削除しません。
保存済みの履歴ファイルはschema 1のままで、移行や初期化は不要です。
詳細は[履歴の契約](docs/design/deployment-history.md)を参照してください。

Agentは不足する名前をまとめて説明し、既存の入力画面を順に開き、実際の操作結果から完了・未完を案内します。
キャンセルや失敗で処理を止め、承認をまとめて省略しません。外部サービスへのログイン、キー発行、購入・
ライセンス有効化、OS本人確認は人間の準備として残ります。新規projectでは、使用中のAgentが
`--host agents` / `--host claude` / `--host cursor`を明示して、そのAgent用の指示だけを作成できます。
既存内容の保護・symlink拒否・`--check`の無書き込みは維持します。

`actor: "human"` / `kind: "register-secret"`では、exact versionのAgent protocolが`save <NAME> --ask`を
要求します。値はHuman Planeだけへ入力され、Agent側へ返るのは状態だけです。

各targetには`deployment`が付きます。`automatic`は「いまAgentが人の操作なしで配置してよいenvironment」、
`humanApproval`はそれ以外、`destinationTrust`はこのprojectの配置先が
`trusted` / `unconfirmed` / `changed` / `unresolved` / `not-applicable`のどれかを表します。
未確認または変化した配置先には`actor: "human"` / `kind: "approve-deploy-destination"`が加わります。
Agentはこれを人へ伝えるだけで、自分では満たせません。

Phase BのSecret inputはWindows / macOSのOSダイアログに対応します。Linux、headless session、固定system helperを
検証できない環境では、人が所有するterminalへのhandoffだけを表示してfail closedします。
Agent-owned PTYへのfallbackはありません。production / GitHub、provider側からread-back可能なVercel
development、`--force`、既存値を上書きし得る
high-risk deployは、Windows / macOSの固定system helperによるAgent-independent Human Planeを使います。
Windows 11 Build 22000以降かつHello設定済みのアカウントでは、plan dialogのYes/DeleteはOS本人確認を
開始するだけで、`IUserConsentVerifierInterop::RequestVerificationForWindowAsync`が`Verified`を返した
場合だけ承認します。承認から実行まで同じ1回の呼び出しに束ね、Linux、Windows 10、Hello未設定の
アカウント、helperを検証できない環境はfail closedです。

Phase Dはその境界の「配置先」側です。実行されるdeployは必ず1つのDestination Identity
（固定したproject realpath、target、environment、配置先を決めるrepository config、同じtrusted CLIと
sanitized environmentで解決したprovider account identity）へ束ねます。人が1度確認するとその identity だけが
OS secret storeへ記録され、初回や変化後はふたたびHuman Planeを通ります。確認済みの配置先で、
`project` scope・`--force`なしのVercel `preview`だけが、次回から確認なしで進めます。

Phase EはlifecycleをAgent-firstへ閉じます。`next --json`は、projectがもう参照していないのに
project scopeへ登録が残るSecretを`status: "unused"`のcleanup候補として示し、
`actor: "human"` / `kind: "remove-secret"`を返します。確認済み配置先が変化した場合は、
`kind: "forget-deploy-destination"`も加わります。どちらも提案であり実行ではありません。

```sh
api-key-case remove OPENAI_API_KEY                        # Human Planeで削除を判断
api-key-case trust status                                 # ここで確認済みの配置先
api-key-case trust forget --target vercel --env preview   # 次回また承認を求めさせる
```

`remove`と`trust forget`は、同じAgentから独立したHuman Planeを通ります。`--yes`もstdin確認もなく、
利用できない環境ではfail closedします。trustを忘れる操作は「次回また人へ聞く」方向にしか働かず、
承認を与えることはありません。それでもsecurity stateの変更なので`actor: agent`にはしません。
`trust status`は読み取り専用で、trust recordの作成・変更はできません。

## デモ

[![API Key Case 操作イメージ](https://apikeycase.melavern.com/launch-ja-poster.jpg)](https://apikeycase.melavern.com/launch-ja.mp4)

**[28秒の操作イメージを見る](https://apikeycase.melavern.com/launch-ja.mp4)**（日本語字幕・音声あり）

GitHub Secretの設定をAgentが案内し、人が専用画面で値を入力・承認する流れを示します。
実際の資格情報を配置した録画ではなく、合成した操作イメージです。実シークレットは含みません。
旧CLIデモの生成コードは `demo/` に参考用として残していますが、旧録画は現行サイト・npm配布に含めません。

## できること

- `.env` と `.env.*` が ignore されているかを確認する
- env ファイルが現在または過去にGitで追跡されていないかを、ネストしたファイルも含めて検出する
- `.env.example` とコード中の参照から、必要な環境変数名を洗い出す
- シークレットらしき値を、元の行や値そのものを再現せずに報告する
- 値が空の `.env.example` を生成する
- AIエージェント向けに `AGENT_CONTEXT.safe.md` と `AI_SAFE_PROMPT.md` を生成する
- JSON出力と、CI向けの厳格な終了コードに対応する
- 値をOSのシークレットストア（Keychain / 資格情報マネージャー / Linux OS keyring）に保管し、
  登録済みか未登録かだけを報告する（値そのものは決して返さない）

スキャナ本体は実際の `.env` の中身を読まず、ネットワーク通信も行いません。対象コマンドの処理が終わった後、テレメトリが有効で条件を満たす場合だけ、別系統の best-effort 匿名利用イベントを送ることがあります。スキャンデータがそのモジュールへ渡ることはありません。

## 匿名利用テレメトリ

CLIでは、製品判断を集計するため、プライバシーを限定した PostHog の `cli_command_result` という1種類のイベントだけを使います。対象は `scan`、`save`、`license_activate`、`deploy` に限り、固定の `product: api_key_case`、`surface: cli` と、コマンド、結果、CLIバージョン、OS種別、`deploy` の場合だけ許可済み配置先など、閉じた値だけを送ります。秘密値・秘密名・環境変数名・パス・スキャン結果・argv・プロジェクト情報・ライセンス情報・端末入力は送りません。

テレメトリは初期状態では有効ですが、最初に対象コマンドを対話的な端末で実行した時、送信前に一度だけ説明を表示します。v0.9.1の配布ビルドには API Key Case 用の公開 PostHog Project Token が組み込まれているため、このビルドでは利用者がtelemetry用tokenを設定する必要はありません。`API_KEY_CASE_POSTHOG_PROJECT_TOKEN` は development / test / override 用のフックとして残り、空でない場合は配布物の設定より優先されます。Personal API Key や Project Secret API Key は package に含めません。配布用tokenを持たない独自ビルドでは安全にno-opします。説明前の非対話実行では送信せず、CI または `DO_NOT_TRACK=1` では常に停止します。PostHog の障害やタイムアウトは無視され、本来のコマンド結果を変えません。匿名インストールIDはランダム値だけで生成し、`~/.api-key-case/telemetry.json` にだけ保存します。端末、利用者、リポジトリ、ライセンス、ハードウェアから生成しません。

```sh
api-key-case telemetry status
api-key-case telemetry enable
api-key-case telemetry disable
```

`disable` は通信を止め、匿名インストールIDを削除します。再度有効化すると新しいIDを生成します。イベント定義と判断ルールは [`docs/analytics/MEASUREMENT.md`](docs/analytics/MEASUREMENT.md) にまとめています。

## やらないこと

- **APIキーの取得は代行しません。** Cloudflare や Vercel や OpenAI にログインして
  資格情報を取ってくる・発行するような連携はありません。値は提供元から自分で取得し、一度だけ入力します
- **`wrangler` / `vercel` / `gh` の置き換えではありません。** `deploy` は、すでにインストール・
  ログイン済みの本物のCLIを実行します。無い場合は、勝手に入れたり迂回したりせず手順を表示します
- **MCPは`production` / GitHub deployを完遂しません。** MCPにapproval parameterやelicitationを追加せず、
  high-risk deployはHuman Planeなしでfail closedします。Agent-owned PTYへの`yes`入力では突破できません
- **シークレットが漏れないことを保証しません。** 実際に何を守り何を守れないかは
  [セキュリティモデルと限界](#セキュリティモデルと限界) を参照してください

## シークレットの保管（`save` / `check` / `list` / `remove`）

`check` / `hasSecret` は、OSシークレットストアの読み取り結果を直ちに真偽値へ畳み、値を返却・保存・
記録しません。人が所有するterminalでは **隠しプロンプト → CLI process memory → OS Secret Store**、
Windows / macOSのAgent-first経路では **Human Plane password dialog → sanitized fixed-path helper memory →
Windows Credential Manager / macOS Keychain** です。macOSでは固定`/usr/bin/osascript`内のJXAが
Security.frameworkへ直接保存し、値を`security` CLIやvalue-bearing child processへ渡しません。helperは親processへ状態だけを返します。
CLIの画面・ログ・AI向け応答へ値を出さず、argvやpipe経由のstdinからも受け取りません。

```sh
api-key-case save OPENAI_API_KEY          # 値を入力（隠し入力、TTY必須）
api-key-case save OPENAI_API_KEY --ask    # Windows / macOS Human Plane。Agent側stdinは読みません
api-key-case check                        # scan が参照する全シークレットの状態
api-key-case check OPENAI_API_KEY --json  # 個別の状態
api-key-case list                         # 名前とメタデータのみ。値は決して出ません
api-key-case remove OPENAI_API_KEY        # OSシークレットストアから削除（Human Planeで判断）
```

主なオプション: `--scope user|project`（既定は `project`）、`--force`（`save` の上書き）、
`--ask`（Agentから独立したHuman Plane Secret input）、`--json`、`--strict`。

`remove` は、high-risk deployと同じAgentから独立したHuman Planeで人間が答えたときだけ削除します。
`--yes` もstdin確認もないため、このprocessのterminalを握るAgentでも削除を完遂できません。
そのdialogを利用できない環境ではfail closedし、OSシークレットストア自体のUIを案内します。

終了コード `3` は、その操作で利用できるOSシークレットストアが無いことを意味します。
Linuxの現行keyring依存は、Secret Serviceが使えない場合にkernel keyutilsへfallbackすることがあります。
D-Bus不在だけではこの終了コードになるとは限らず、`available`でもログイン・再起動をまたぐ保存は
保証しません。[確認された制限](SECURITY.md#known-limitations)を参照してください。

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

`production` への配置、**github へのすべての配置**、provider側からread-back可能なVercel
`development`、`--force`、`--scope user`、および既存値を上書きし得る操作は、
計画を固定Windows PowerShellまたはmacOS AppKitのHuman Planeへ表示します。WindowsではYes/Deleteの後に
OS本人確認を要求し、`Verified`以外をすべて拒否します。stdin、MCP、承認token、これを飛ばすフラグはありません。
LinuxではAgent-firstの入力・承認・配置に必要な条件を満たさないため、人間のhandoffだけを表示して拒否します。
Windows 11 Build 22000未満、Hello未設定のアカウント、その他の条件を満たさない環境も同様です。

それ以外も、人が一度確認した配置先でなければ実行しません。確認なしで繰り返してよいのは
`project` scope・`--force`なしのVercel `preview`だけで、しかもDestination Identityが変化していない間に
限ります。Cloudflareは`wrangler secret put`が常に上書きするため、GitHubはenvironmentに関わらずCIから
参照できるため、自動化の対象外です。

実行されるdeployでは配置先を一意に固定するため、Cloudflareは`name`と`account_id`を含む単一のWrangler
config、Vercelはorg / project IDを含む`.vercel/project.json`、GitHubはrepository rootの
`.git/config`にある単一で曖昧さのない`github.com`の`origin` remoteを要求します。ダイアログには
配置先、初回か前回承認から変化したか、固定provider identity、cwd、CLI path、environment、command、
破壊的pre-stepを表示し、曖昧または変化した状態は拒否します。Windowsではtrusted CLIとprofileをregistryから、
macOSではOS user databaseとarchitecture-awareな閉じたinstall locationから解決します。どちらもcallerの
`PATH` / `HOME` / provider credential environmentを継承せず、同じexact CLIを再検証します。macOSのNode shebang CLIは
exact Node runtimeも同様に固定・再検証します。Linuxでは手順を表示して拒否します。

### 渡したあと、値がどう扱われるか

手を離れた値は、このツールではなく各プラットフォームのルールの下に置かれます。とくに次の2点は
知らないと事故になります。

- **GitHub は `--env` によって作られるものが変わります。** `development`（既定）は
  **repository secret** で、そのリポジトリの全workflowから使えます。`production` / `preview` は
  **environment secret** で、`environment:` を宣言したjobだけが読めます。
  つまりGitHubでは**既定の `development` が最も広いスコープ**になり、名前の印象と逆です。
- **Vercel の `development` に置いた値は読み戻せます。** `deploy` はここに `--sensitive` を
  付けないため Config 変数として保存され、プロジェクトにアクセスできる人は
  `vercel env pull` で値を読み戻せます。読み戻されたくない値を `development` に
  置かないでください。以前の Vercel は `development` の sensitive 変数自体を拒否して
  いましたが、`vercel` 59.11.7 では受け付けます（2026-09-08 実測）。したがってこれは
  現在、プロバイダ側の制約ではなく本ツールの保守的な既定です。
  `production` / `preview` へは、Vercel側の既定に頼らず `deploy` が自分で `--sensitive` を
  付けて登録するため、値は読み戻せません（deploy前に表示される plan にこのフラグが出ます）。
  `preview` にはさらに `--yes` を付けます。CLI が尋ねる Git ブランチの既定
  （すべての Preview ブランチ）をそのまま採るためで、これが無いと非対話実行は
  その質問で止まり、何も作らないまま成功として終了します。

Cloudflare を含む3社の詳細な挙動は、英語READMEの
[What each platform does with the value after that](README.md#what-each-platform-does-with-the-value-after-that)
を参照してください。

## 価格とライセンス

診断・readiness・Agentの初期設定・OS保管・配置先の信頼の管理と、`deploy_secret` を除くMCP機能は
対応環境と承認条件の範囲で **¥0** です。`deploy`（`--dry-run`を含む）は Lemon Squeezy での**買い切り ¥2,980**（サブスクリプションではありません）で
解放されます。購入にはv0.9.1と、**Pro v1（1.x系）の範囲**のアップデートが含まれます。
将来のメジャーバージョンは別ライセンスになる場合があります。

| 機能 | Free | Pro |
| --- | :---: | :---: |
| ローカルスキャンと伏字済みエージェントレポート | ✓ | ✓ |
| OSシークレットストア（`save` / `check` / `list` / `remove`） | ✓ | ✓ |
| 配置準備の診断・Agent初期設定・配置先の信頼の管理 | ✓ | ✓ |
| `deploy_secret`を除くMCP機能（任意） | ✓ | ✓ |
| Cloudflare / Vercel / GitHub への `deploy`（dry-run含む） | — | ✓ |

1購入は1名分で、その方ご自身の端末とプロジェクトで使えます。組織で使う場合は利用者ごとに1購入が必要です。
返金は[返金ポリシー](https://apikeycase.melavern.com/refund)に基づき14日以内で受け付けます。
[利用規約](https://apikeycase.melavern.com/terms)は公式のPro権利とサービスに適用されるもので、
ソースコードの利用許諾とは別の層です。ソースコードには各versionに同梱された`LICENSE`が適用されます。

```sh
api-key-case license activate     # 隠し入力での対話式。argvと非TTY入力は拒否されます
api-key-case license status [--json]
api-key-case license deactivate
```

購入すると Lemon Squeezy から購入キーがメールで届きます。`license activate` はそのキーを一度だけ
HTTPSで交換用Workerへ送り、Worker側で Lemon のライセンス・店舗/製品/バリアント・支払い済みかつ
未返金であることを検証したうえで、Ed25519署名済みの `AKC1` ライセンスを返します。以降のPro判定は
**完全にローカル・オフライン**です。ライセンスの再検証、端末紐付け、有効期限確認はありません。これは、上記の停止可能な匿名利用テレメトリとは別の仕組みです。

API Key Case 0.9.1の製品コードは、Elastic License 2.0（`Elastic-2.0`）のもとで
source available（ソースコード公開）として提供します。Secret境界に関わる実装、テスト、設計記録も
引き続き公開し、その挙動と境界を確認できます。これは第三者による独立監査済みという意味ではありません。
Pro利用権とライセンスキー実装は変更せず、ソースコードライセンスとは別の層として扱います。
生成instruction、ブランド、第三者素材の境界は[NOTICE](NOTICE)に、設計と脅威モデルの全体は
[docs/design/phase-5-license.md](docs/design/phase-5-license.md)に記載しています。

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
| Ubuntuでの配布物・実OSストア検証 | [検証記録](docs/VERIFICATION.md#ubuntu-artifact-and-real-store-verification--2026-09-08) |
| 公開候補の受入手順と残作業 | [Release checklist](docs/RELEASING.md) |
| 今後の予定 | [Status and roadmap](README.md#status-and-roadmap) |

## ライセンス

API Key Case 0.9.1の製品コードはElastic License 2.0（`Elastic-2.0`）で提供し、`deploy`を含む
全ソースを引き続き公開します。`agent-init`が生成するmanaged instruction textだけは、利用者が自身の
repositoryで保存・編集・共有できるよう標準0BSDで提供します。この限定は周囲のrepositoryや
`agent-init`の実装コードのライセンスを変更しません。0.9.0には、そのreleaseに同梱されたMITライセンスが
引き続き適用されます。正確な範囲は[LICENSE](LICENSE)、[0BSD本文](LICENSES/0BSD.txt)、[NOTICE](NOTICE)を
参照してください。

サポートと貢献について: [SUPPORT.md](SUPPORT.md) ·
[CONTRIBUTING.md](https://github.com/melavern/api-key-case/blob/main/CONTRIBUTING.md)

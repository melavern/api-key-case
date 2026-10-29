# 非公開版: 1つのアプリで保存・利用・配置・再開をつなぐ

中心となる対象は、レビュー済みprivate checkoutのWindows開発版、Resend、通常のNode.js/TypeScriptアプリ。
既にVercel管理下にあるClerk/Next.jsアプリの限定した設定確認は、末尾の別profileを使う。
公開npm 0.9.2にこの体験があるとは扱わない。保存済みキーを同じ環境で再利用するだけなら、別のResendキーやResendアカウントは不要。
実際のアプリ実行・Secret配置・メール送信は、対象と作用を決めて許可を得た操作だけ行う。
この手順を読むことやpreviewの成功は、その許可にならない。

## 最初に決めること

Agentは既存アプリの構成を調べ、人には未確定の「どのアプリ・環境・配置先か」だけをまとめて確認する。
既に指定済みなら聞き直さない。Agentが作業を進める入口は同じprivate checkoutのCLIに統一する。

| 使う場所 | 環境 | 既存の前提 |
| --- | --- | --- |
| 同じWindows上のNodeアプリ | developmentのみ | 対応する固定`dist/*.cjs` artifact。毎回Proとnative承認が必要 |
| Vercel | development / preview / production | 対象projectが既にlink済み |
| Cloudflare | development / preview / production | 対象Worker/accountの既存Wrangler設定。productionはdefault、他は同名env設定 |
| GitHub Actions | development / preview / production | github.comの単一originと、同名のGitHub Environmentが既に存在 |

公式integrationで既に目的を満たしているなら、その経路を使い、vaultへ二重保存しない。
以下はAPI Key Case管理の経路。1プロジェクトのResend選択中intentは1つで、配置先を変えるとその選択が変わる。
保存済みcredentialはproject × service × environmentごとの別slotに残る。
Resendの`connection set`に同じ環境・経路・配置先・送信domainを再指定しても、選択revisionは変わりません。
保存済みのアプリ準備や過去の観測を引き継ぎます。期限は延長せず、実際に選択を変えた場合は変更として扱います。

## Agent側の準備

レビュー済みcommitのprivate checkoutを使い、そのcommitを試用記録に残す。必要ならcheckoutで
`npm ci --ignore-scripts`、`npm run build`を行う。公開版の`npx api-key-case@0.9.2`と混ぜない。
以下の`<cli>`はそのcheckoutの`dist/cli/index.js`の絶対パス、`<app>`は選んだアプリの絶対パス。
空白を含むパスはshellに合わせて引用する。公開npmへのpublishや全体のWindows再受入は、この試用の準備ではない。

試用するappのAgent案内は、その実行中のprivate CLIから作る。`--host`は実際に使うAgentだけを選ぶ。

```text
node <cli> agent-init --use-current-cli --host <agents|claude|cursor> <app>
node <cli> agent-init --use-current-cli --host <agents|claude|cursor> --check <app>
```

生成したstdoutとmanaged blockには、検査済みのNode/CLIの絶対パス、literal argv、versionとschemaが入り、
最初の操作は同じCLIの `next --json --offline .` になる。次の会話のAgentはこの案内を読み、選択環境と過去の
観測を復元できる。登録・local操作も同じ入口を使い、Ownerがprivate pathを毎回説明し直す必要はない。
POSIX shellとPowerShellの引用を区別し、空白・日本語・引用符をコマンドとして解釈しない。
この案内は同じ機械の入口で、持ち運べるinstall設定ではない。入口が消失・移動・利用不可なら停止し、
利用可能な信頼済みCLIから作り直す。project metadataから実行pathを推測せず、公開npxへfallbackしない。
一時的なnpx cacheの入口は生成時に拒否する。flagなしの既存公開版向け案内は従来どおり。
managed blockの手編集は従来どおり拒否し、`--check`は書き込まない。offline復元は入力・実行・再送の許可ではない。

local選択の再開では、schema 12の`localDevelopment`と`localSession`を読む。
保存したアプリ・環境と登録済みslotを引き継ぎ、人に同じ選択やキー入力を要求しない。
`prepare-and-inspect`ならAgentが既存source/buildを確認し、使えるartifactを再利用するか必要な場合だけbuildして、
下記の既存local inspectへ進む。build/inspectionの`not-inspected`は未実施の証明ではない。
`review-trial-observations`なら終了・後始末・その試行の観測を説明し、build・起動・送信・キー入力を繰り返さない。
`trialObservations`は最新の同じ試行について、アプリの観測と本人の受信報告を別々に示す。
`review-application-observation`なら保存済みアプリと既存結果から、その機能で何を確認したかを調べる。
`not-reported`は報告がない状態で、失敗や未確認の証明ではない。本人の受信報告を聞き直したり、自動で送信したりしない。
`review-mixed-observations`は同じ役割から異なる結果が記録された状態。過去の結果を残して内容を確認し、後の成功だけで上書きしない。
未起動は`review-unstarted-attempt`、lock/終了不明は`review-previous-attempt`、
読取り不明や変化は`review-local-state`として既存statusを確認する。選択/credential変更や旧receiptは過去の証拠を保つ。
対応外hostや未確認の登録を、新しいキーやWindows確認の依頼に置き換えない。
`review-local-preparation`なら`preparationReceipt`を読む。`unchanged-metadata`は過去inspectのartifact候補を
そのまま既存inspectへ渡し、アプリ・キーを聞き直したり、最初からbuildしたりしない。
入力変更はsource/buildを見直し、artifact/Node変更や期限切れは必要な再inspectへ分ける。
環境・選択・登録変更では候補を使わず対象を確認する。過去のmetadata一致は本文検証・build由来・成功の証明ではない。
過去の成功は現在readyや再実行許可にならず、新しいrunには対象と作用の依頼・既存native承認が別途必要。

```text
node <cli> connection set --service resend --env <environment> --route api-key-case-managed --destination <local|vercel|cloudflare|github> <app>
node <cli> connection credential check --service resend --env <environment> --json <app>
```

`registered`なら再入力しない。`missing`の場合だけ、対象slotへの登録が依頼されていることを確認し、
同じCLIの`connection credential save --service resend --env <environment> <app>`でHuman Planeを開く。
値の入力・必要なOS本人確認は人が行う。Agentへ値を貼らせず、ファイル・argv・通常ログへ値を残さない。
`unavailable`ならstoreへのアクセスを確認できていないので、未登録と決めつけたり再入力を要求したりしない。
登録済みでも、後段のinspectがrevision/metadataの不整合を報告したら先へ進めず、既存の記録を保ったまま確認する。
解消のために自動上書き・`--force`・別slotへのfallbackを行わない。
`check`は書込み・削除のavailability probeを使わない。ただしOS-storeのpresence APIは内部で値を読み捨てる場合がある。

## Vercelの公式integrationが管理している場合

既存の公式integrationを使うなら、キーをAPI Key Caseへコピーする前に、そのprojectと環境を選ぶ。
既に選択済みなら選び直さない。同じprivate CLIにこのコマンドがある場合だけ使う。

```text
node <cli> connection set --service resend --env <environment> --route provider-native --destination vercel <app>
node <cli> connection native inspect --service resend --env <environment> --json <app>
```

人が結果を読むときは`--json`を省略できる。設定の存在とアプリ機能の未確認を別々に表示し、
公式連携の設定がある場合はキーの二重登録が不要であることと、別途許可されたアプリでの機能確認を案内する。
`--record`を付けない場合、JSONのschema・fingerprint・未確認の扱いは変わらず、確認結果は保存されない。

対応するVercel CLIはレビュー済み59.11.7に限定する。別versionならGET前に停止し、自動install・downgradeしない。
これは既存のVercel CLIログインを使う明示的なオンライン確認。CLIの認証更新が起きる場合がある。
新規ログイン・インストール・env pull・キー登録・アプリ実行は行わない。
AgentはVercel CLIの生の環境変数一覧を取得しない。値を含む場合があるため、この確認の閉じた結果だけを使う。

- `integration-managed`: 同じ環境のRESEND_API_KEYをVercelがintegration由来と報告した。vaultへ二重登録しない。
- `present-unmanaged`: 名前は存在するがintegration由来と確認できない。自動上書きやキーのコピーをせず、既存設定を確認する。
- `absent`: この確認時点で対象環境の名前を確認できなかった。選択した公式integrationの設定を確認する。
- `unknown`: 不在とは判断できない。認証・CLI対応・設定変更などを確認し、再入力や再実行を自動で要求しない。

integrationの提供者がResendであること、キーの有効性、既存deploymentへの反映、アプリの送信成功は別の確認。
設定確認も、その保存済み記録も、通常のconnection planをreadyにしない。`termination-unconfirmed`なら所有CLIの終了を確認してから
次の操作を判断する。アプリでの実動作は、対象と作用を承認した別の確認で行う。

### 設定確認とアプリ機能の観測を引き継ぐ

schema 11以降のprivate CLIでは、既存の観測journalへ設定確認を明示的に保存できる。
ResendとClerkの選択済みVercel project・環境に対応し、新しいキーやvaultへのコピーは不要。

```text
node <cli> connection native inspect --service <resend|clerk> --env <environment> --record --max-age-seconds 600 --json <app>
```

このコマンドは上記と同じ明示的なオンライン確認。保存する場合のJSONは
`{schemaVersion: 1, inspection, recording}`で、従来の結果は`inspection`にそのまま残る。
`recording.status: recorded`なら`recording.receiptId`を引き継ぐ。
`inspection.status: unknown`も記録できるが、設定済みとは扱わない。

別途許可されたアプリ機能を実際に確認した後、その結果だけを次のコマンドで保存する。
このコマンド自体はアプリもproviderも実行しない。

```text
node <cli> connection native observe-application --service <resend|clerk> --env <environment> --inspection <receipt-id> --feature <protected-access|send-and-delivery> --observer <agent|human> --outcome <passed|failed|unknown> --max-age-seconds 300 --json <app>
node <cli> next --json --offline <app>
```

Clerkの`protected-access`は未認証時の拒否と認証後の保護機能へのアクセス、Resendの`send-and-delivery`は
アプリからの送信と配送の確認に使う。確認範囲が不足する場合は`passed`を記録しない。
Agentが確認した結果は`agent`、人からの報告は`human`を指定し、観測者を置き換えない。
保存には、同じ選択・環境・projectに対応する最新の設定確認receiptが必要。
設定が`integration-managed`または`present-unmanaged`で、確認期限内の場合に限る。
任意のcommand・URL・ファイル本文・キー・自由文は受け取らない。

`next`はClerkなら`clerkNative.applicationObservation`、Resendなら
`connection.report.nativeApplicationObservation`で、機能・結果・観測者・記録時刻・期限・対象fingerprintと
残る確認を返す。現在の選択と過去の対象fingerprintを区別し、過去の成功を別projectへ読み替えない。
同じ設定を再確認してもアプリ観測の期限を延ばさない。設定や選択の変更、期限切れ、保存中断、
unknownでは既存の記録を保って確認し、アプリ操作やprovider操作を自動で繰り返さない。

これは記録した機能の観測履歴。`currentHealth: unverified`と`permission: none`は常に残る。
source・依存関係の現在の一致、キー有効性、現在のアプリ正常性や通常のplanのreadyを保証しない。
`next --offline`は記録を更新せず、providerやアプリを呼ばない。公開npm 0.9.2にはこのコマンドはない。

## 同じWindowsで使う

`local` / `development`を選択してから、対応する既存JS/TS entryをAgentが選び、別工程でbuildする。
このhelperはprivate checkoutの開発用ツールで、npm artifactには同梱されていない。

```text
node <private-checkout>/tools/build-local-node.mjs <app> --entry src/main.ts
node <cli> connection local inspect --service resend --env development --artifact <returned-artifact> --max-seconds 1800 --json <app>
```

実際のentryが別ならその対応sourceを使う。依存packageはruntimeで使われ、自己完結bundleにはならない。
`ready-for-review`は承認候補であり、実行済み・メール成功ではない。
対象appと具体的作用が許可済みの場合だけ、同じartifactと時間を指定して`connection local run`へ進む。
毎回Proとnative承認が必要。アプリ・依存関係・同一OSユーザーからの漏えい防止は保証しない。
出力streamをAgentへ転送しないため、機能の成否はappの既存画面や閉じた結果と人の観測で別に確認する。
詳細と対応外入力は[通常のNode開発手順](LOCAL_NODE_DEVELOPMENT.md)を参照。

## 同じ環境のキーを配置先でも使う

人が選んだ配置先へ`connection set`を変更し、同じ環境の`credential check`を行う。
local/developmentからGitHub/developmentなどへの変更では、保存済みdevelopmentキーを再入力しない。
productionは別slotなのでdevelopmentキーで代用しない。

```text
node <cli> connection deploy --service resend --env <environment> --dry-run --json <app>
```

これはoffline preview。providerのloginや遠隔設定を確認せず、Secretを配置しない。
選ばれた環境・配置先・上書き可能性を読み、実際の配置が許可された場合だけ`--dry-run`を外す。
実行はPro、固定provider CLI、現在のdestination確認、既存のHuman Plane承認規則を通る。
GitHubはdevelopmentを含め常に同名Environmentへ配置し、repository-wide secretへfallbackしない。
GitHub/Cloudflareは上書き可能で毎回承認が必要。Vercelは[既存の承認条件](design/connection-deployment.md)を保つ。
CLIが成功しても、アプリ機能やGitHub workflowを実行したことにはならない。

## 中断したら、まず結果を読む

```text
node <cli> connection local status --service resend --env development --json <app>
node <cli> history --json --offline <app>
```

local statusは終了・cleanupと当該試行の観測履歴、historyは過去の配置結果を示す。履歴は再実行の許可にはならない。

所有CLIが同じ実行内で未起動またはprocess treeの終了を確認済みなら、結果保存・lock削除のI/O失敗に限り、
完了処理だけを一度追加試行する。アプリ・承認・キー読取りは繰り返さない。
なお失敗する場合、run結果の`completionFailure.phase`と`issue`で保存段階かlock削除段階かを区別する。
`receiptSaved: false`でも結果保存済みでlockが残る場合がある。新しい会話での所有権、終了不明、
receiptやlockの差替えをこの処理で補うことはできない。metadata編集やlock手動削除で次の起動を通さない。

新しい試行が終了し、後始末まで確認できた場合だけ、実際に観測したアプリの結果を記録できる。
statusのその試行にある`attemptId`、`executionBasisId`、`credentialRevision`を使う。本文・宛先・生出力は入力しない。

```text
node <cli> connection local observe --service resend --env development --attempt <attemptId> --execution-basis <executionBasisId> --credential-revision <credentialRevision> --authority agent-observed --outcome <passed|failed|unknown> --json <app>
```

本人が受信結果を報告した場合は、同じ試行に対して別の報告として記録する。
`--authority human-reported --outcome <received|not-received|unknown>`を使い、Agentが受信を推測しない。
記録時には送信・アプリ起動・キー入力・本人承認を行わない。次の会話では同じCLIの`next --json --offline`で復元できる。
終了だけで成功とせず、観測はその試行の履歴として読む。現在の健康状態、generic ready、再実行許可には使わない。
旧receipt、未終了、unknown、changed、lock、選択・credential変更、保存失敗では記録を拒否する。
過去の実受信成功を新しい試行に付け直したり、拒否を避けるためにmetadataを編集したりしない。
前の試行は最大20件、試行ごとの報告は最大20件保持する。新試行には古い報告を引き継がない。
unknown、owner-review-required、保存失敗、provider作用の不確実性があれば、実行を繰り返さず既存証拠を残す。
配置先の再選択や新artifactのbuildで、以前のreceipt・lock・attemptを消さない。
`incomplete`も「遠隔には何も起きていない」ではない。保存・配置・process終了・provider受付・人の受信確認を分ける。
一般的な`connection plan`はlocal/GitHubでreadyを保証しない。CLIを呼べる既存Agent経路を使い、
7つのlegacy MCP toolにv2実行機能があるとは扱わない。

## 一度の試用で残す記録

使用commit、app、環境、選択先、再入力が必要だった回数、操作ごとの閉じたstatus、機能観測とその観測者を残す。
キー本文・認証画面・生のprovider診断は記録しない。保存済みキーの同環境再利用なら、配置先変更だけで再入力は不要。
live送信や配置の許可が無ければinspect/previewまでで止め、実機・実provider成功と報告しない。
既存の17/19ケースや倍率チェックをこの手順のたびに繰り返す必要はない。


## 開発確認（2026-10-03）

合成の通常TSアプリをbuildし、実際のprivate CLIで8回選択を変更するjourneyを確認した。
developmentの合成登録は1回、productionは独立した1回で、同環境の配置先変更では再入力せず、
別環境へのfallbackや中断receipt/lockの消去も起きない。previewは既存core経路を用いたoffline確認で、
appやproviderを実行した証明ではない。独立レビューでもjourney、従来の登録・削除・環境分離、Agent案内が通過した。
最終Linux aggregateは隔離したmock keyringとprovider/native呼出し防止の下で200.8秒、offline package smokeは
21.4秒で通過（162同梱file、試験前後のhash一致）。gitless作業環境のため共通preflightは実行できず、
remote tree/blob照合を別に行った。hosted CI成功、実provider配置、追加のWindows受入、公開releaseとは扱わない。
このguide/helper/testはnpm配布物に含まれず、private source checkoutから使う。


## 既存のVercel管理Clerkアプリ

Clerkの公式Vercel Marketplace integrationで既に作成・接続されているアプリだけが、このprofileの対象。
既存の単独ClerkアプリをMarketplace管理へ移せるとは扱わない。新規アカウントやアプリの作成、plan選択、
権限付与、認証基盤の移行は、この確認に含めない。

```text
node <cli> connection set --service clerk --env <environment> --route provider-native --destination vercel <app>
node <cli> connection native inspect --service clerk --env <environment> --json <app>
node <cli> next --json <app>
```

この`native inspect`も`--json`を省略すると人向けの結果を表示する。Clerkでは、設定の存在を認証成功と扱わず、
別途許可された対象アプリでのログアウト時のアクセス拒否とログイン後の保護ページへのアクセスを次の確認として案内する。

Clerkの選択はResendと別に残る。Resendの保存済みslotや中断中sessionを消したり、Clerkへ使い回したりしない。
private版`next`では`clerkNative`を読む。既存の`connection`はResendのまま。
全体の`next`は従来の診断も行うため、純粋なoffline操作とは扱わない。

必要な組は`CLERK_SECRET_KEY`と`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`。
後者は公開設定だが、このprofileではその値も出力しない。Vercelがアプリへ両方を渡すので、Agentがコピーする必要はない。
Vercelのdevelopment/previewはClerkのdevelopment、productionはClerkのproductionを使う想定。
これは期待する対応であり、値を照合してinstanceを確認した結果ではない。

`settings`は各役割の存在、`configuration`は組全体の状態を示す。
`integration-managed`は、同じ対象環境にbranch制限のない2つの設定があり、configurationIdの帰属が一致した意味。
`partial`は片方だけ、`absent`は両方不在、`present-unmanaged`は両方あるがintegration由来と確認できない状態。
重複・対象違い・帰属の不一致・読取失敗は`unknown`。この場合は各役割の存在も`unknown`として返すことがある。いずれも再保存・上書き・他環境へのfallbackを自動で行わない。
Clerk本人のintegrationか、2つの値が同じinstanceのものか、認証が動くかは別の確認になる。

Coding Agentは既存アプリのSDK・表示・resource単位の認証チェックを扱う。
`clerk init`はアプリの新規作成、`.env.local`へのキー保存、Agent skillのglobal installを行う場合があるため使わない。
`vercel env pull`も使わない。このVercel公式連携ではcredentialへの二重登録は不要。
Clerkのlocal / deploy / provider checkは未対応。単独アプリの保存枠の存在確認は、後述の別コマンドを使う。
既存のlegacy汎用save/deployは別契約で、このflowから自動fallbackしない。
`clerkMiddleware`を置いただけではresourceは保護されない。
実機能の受入は、別途許可された対象アプリで「ログアウト状態で保護ページへ入れない」「ログイン後に入れる」を確認する。
設定名の存在やこのコマンドの成功だけで、認証機能が完成したとは報告しない。


### Clerk単独アプリの保存枠（開発中）

同じprivate checkoutのCLIで `connection credential check --service clerk --env development --json .`
を使うと、そのアプリ・環境の `CLERK_SECRET_KEY` の登録有無だけを確認できます。
保存・削除は限定受入済みのWindows経路で使えます。他OSでは引き続き利用不可です。
公開版0.9.2の `npx` に置き換えたり、従来の `save CLERK_SECRET_KEY` へ逃がしたりしないでください。
Vercel公式連携で管理済みなら二重保存は不要です。公開用キーはSDKの通常設定として扱います。
`next.connection` はResend、`next.clerkNative` はVercel公式連携の案内です。
private版schema 6の `next.clerkManaged` は、選択した環境の保存枠・ローカル設定・過去の準備記録をまとめます。
その `summary` と `nextStep` で次に確認する箇所を読み取れます。過去のversion記録があっても、
現在の対象との一致・本番切替・ログイン成功は未確認です。結果不明や記録変更なら再送せず履歴を確認します。
この追加部分はproviderを呼びませんが、next全体には従来のCLI/保管先probeが残ります。


### ClerkをCloudflareへ用意する候補

既存Workerを対象に、private CLIで `connection set --service clerk --env development --route api-key-case-managed --destination cloudflare .`
を選び、`connection prepare --service clerk --env development --dry-run --json .` で対象を確認します。
Worker名・account_idをその環境のWrangler設定へ明記します。公開用キーとSDKの設定は通常のアプリ開発で扱います。
準備実行は限定受入済みWindows経路で使えます。Proと毎回のnative承認が必要で、実際の対象・作用への許可も別途必要です。

この候補が行うのは、Clerkのキーを持つWorkerバージョンの作成です。本番バージョンは切り替えませんが、
既存のVersion URLから呼べる場合があります。対象Workerの最新コードが実行前に変わり得ることも承認画面に示します。
返されたversionIdは後の通常のアプリ配置で使います。結果不明なら再送せず、`history --json --offline .` の記録を確認します。
保存・準備・認証成功はそれぞれ別で、この候補だけでログイン機能が動いたとは報告しません。

通常のアプリ側の配線には[小さいClerk Worker例](../examples/clerk-worker/README.md)があります。
実SDKで保護routeを確認でき、公開設定・remote latestのコード準備・保存slot・version作成の順序を示します。
合成署名を使うofflineテストであり、実Clerkのサインイン結果は別途観測します。


### Worker準備後の通常CLI表示

`connection prepare` の通常表示は、`prepared` のとき作成された正確なversionIdを示します。
これはバージョン作成の結果で、本番への切替やClerk認証の成功ではありません。後のアプリ配置は、
別途許可された通常の手順でそのversionIdを対象にします。既存のVersion URLから呼べる可能性は残ります。

履歴を保存できなかった場合は、作成成功と記録失敗を分けて表示し、後続作業を止めるよう案内します。
作用が不明・途中変更・CLI終了未確認なら自動再送や有効化をせず、同じprivate CLIと同じprojectで
`history --json --offline` を読み、既存証拠を残して次の対応を判断します。履歴が無いことは未実行の証明ではありません。
JSONの項目・status・終了codeは変更せず、通常表示もraw provider診断やキー本文を返しません。

この表示変更はbuild、従来の39件の隔離したClerk準備ケース、通常CLI表示8ケースと同じ結果のJSON比較、
不正なID・raw診断の非返却ケースで確認しました。実engineの39ケースを終えた後、使い捨てcompiledコピーだけで
閉じた結果へ差し替えてCLIを起動しています。製品には結果差し替え経路を追加していません。
実キー・実provider・native操作はなく、JSON/status/終了codeと両Clerkゲートは不変です。
これは機能利用・本番切替の受入ではありません。gitless preflightは実行を試みたものの利用不可でした。
この限定draftではfull aggregate/package/hosted CIを再実行したとは扱いません。

### プロジェクトを開き直して、残っている作業だけ確認する

schema 12では、Clerk／Cloudflareの準備versionに結び付いた保護機能の観測も引き継げます。
`clerkManaged.applicationObservation`は現在選択した環境・account・Workerと、準備記録・観測時の対象を別々に返します。
新しい準備記録には非秘密のaccount／Worker identityが残ります。旧記録に対象情報が無ければ未確認のまま保持し、
今のWrangler設定で過去の対象を補いません。記録のために選択・キー登録・準備を繰り返さないでください。

別途許可された作業で、意図したversionについて未認証時の拒否と認証後の保護機能へのアクセスを確認したら、
最新の準備receiptとversionを使って、その観測だけを保存できます。

```text
node <cli> connection observe-application --service clerk --env <environment> --preparation <receipt-id> --version <version-id> --feature protected-access --observer <agent|human> --outcome <passed|failed|unknown> --max-age-seconds 300 --json <app>
```

このコマンドはアプリ・provider・有効化を実行せず、キー本文も読みません。人の報告は`human`として残します。
versionとの対応は観測者の申告で、稼働中versionを独立に検証した結果ではありません。
同じproject・環境の最新の完了した準備記録と、account／Worker・登録revisionが一致する場合に限り保存できます。
選択・version・登録の変更、新しいunknown、期限切れ、保存中断は確認が必要な状態として返します。

`review-application-observation`なら保護機能の観測が未確認・不明・期限切れ、`review-recorded-failure`なら失敗記録の確認、
`review-recorded-version`なら観測記録とversion利用の確認です。準備済みを配置済み・稼働中とは扱いません。
成功記録があっても`activation: not-inspected`、`currentHealth: unverified`、`permission: none`を保ちます。
Vercel nativeの観測とは別に読み、実アプリ操作・準備・有効化を自動で繰り返しません。

対応するPrivate checkoutをbuildした同じCLIで実行します。

```text
node <checkout>/dist/cli/index.js next --json --offline .
```

選択した接続・環境、キーの存在確認、Clerkの過去のversion準備記録と未完了の
作業を確認できます。Cloudflare / Vercel / GitHubへのログイン確認や外部CLI、
ストアへの書込みテストは行いません。通常の `next --json` は従来どおりです。
公開npm 0.9.2ではこのflagを使えません。

この出力の `targets: []` は「配置先なし」ではなく「今回は未検査」です。
ストア全体の利用可否とGitのignore・追跡・履歴検査も未実施です。
キーの存在確認は選択した環境の枠に加え、従来のproject/user枠も対象になります。
OSストア内部で値を読み捨てる場合がありますが、本文は返しません。
接続内のstage・recoveryは残っている作業の説明です。実行許可ではなく、
今回は絞り込まれたnextActionsに従って状態を確認してください。
記録の存在は現在のアプリ動作や再実行の許可ではありません。結果が不明な操作は
記録を残し、勝手に再送しないでください。

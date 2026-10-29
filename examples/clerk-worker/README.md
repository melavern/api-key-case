# Clerk の保護機能を持つ通常の Worker 例

既存の Clerk アプリと Cloudflare Worker に、ログイン済みユーザーだけが読める
`GET /private` を接続する小さい例です。API Key Case が保存・準備した
`CLERK_SECRET_KEY` を Worker の通常の binding で受け取ります。
公開設定 `CLERK_PUBLISHABLE_KEY` と `APP_ORIGIN` は通常のアプリ設定です。
Secret をファイル・CLI引数へ書く手順はありません。

## 先に確認できること

このディレクトリは独立した private package です。固定した `@clerk/backend` と lockfile を使います。
依存の復元だけは通常の npm registry を使います。アプリ・アカウントの作成や provider 操作は行いません。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

依存がキャッシュ済みなら復元にも `--offline` を追加できます。
テストは実SDKの署名検証を使い、合成RSA鍵/JWTをプロセス内で生成します。
JWKS取得は in-process 応答へ置き換え、外部fetchへ進む経路はありません。
未認証・偽署名・期限切れ・未来の有効時刻・異なる/欠けたorigin・ユーザー不在を拒否し、
有効な合成sessionだけが保護機能へ到達することを確認します。
応答は固定の結果だけで、キー・JWT・ユーザー記録を返しません。

これで確認できるのはアプリコードとSDKの配線です。実Clerkでのログイン、実Workerへの配置、
保存された実キーの有効性を確認した結果ではありません。API Key Case の観測状態も更新しません。

private checkout本体を通常の `npm run build` でbuild済みなら、このディレクトリで
`npm run test:connection` も実行できます。既存の環境別metadata/存在確認/Worker設定parserを使い、
developmentだけの合成memory slot、別環境とResendへの非fallbackを確認します。
実OS保管・native承認・handoff・遠隔配置は行わず、この確認をそれらの受入に置き換えません。

## 実アプリへつなぐ順序

対象は既存の同じアプリ・development環境です。実際の配置やキー使用は対象と作用への許可を得てから行います。

1. 既存フロントエンドの同じorigin配下で `/private` を Workerへ向けます。この例はCORSやログイン画面を新設しません。
   `wrangler.example.jsonc` の内容を既存設定へレビューして取り込み、developmentのWorker/accountを明記します。
   公開用キーはそのClerk development instanceのもの、APP_ORIGINは既存フロントエンドの正確なHTTPS originです。
   API Key Case用に別Clerkアプリ・別キーを作る必要はありません。
2. 通常の許可されたアプリ配置手順で、このコードと公開設定を対象Workerの最新versionへ用意します。
   **先にAPI Key Caseのprepareを行っても、このローカルコードはアップロードされません。**
   prepareは遠隔のlatestを対象にするため、配置担当Agentはそのコードと対象を確認します。
3. 同じprivate API Key Case checkoutのCLIで次を使います。公開版0.9.2のnpxへ置き換えません。

```sh
node /path/to/api-key-case/dist/cli/index.js connection credential check --service clerk --env development /path/to/app
node /path/to/api-key-case/dist/cli/index.js connection set --service clerk --env development --route api-key-case-managed --destination cloudflare /path/to/app
node /path/to/api-key-case/dist/cli/index.js connection prepare --service clerk --env development --dry-run --json /path/to/app
```

未登録の場合だけ、同じproject/environmentの `connection credential save` をWindowsの入力画面で行います。
キー入力は所有者が行い、Agentへ貼りません。別環境やlegacyの保存枠へfallbackしません。
本実行は `--dry-run` を外した同じprepareを、Proとその場のnative承認の下で行います。
最新コードは操作前に変わり得て、作成versionが既存Version URLから使える場合があることも承認対象です。
`prepared` の exact versionId は通常の別途許可された有効化手順へ渡します。
通常のcode uploadを後から重ねて別versionを有効化しないよう、配置担当Agentが対象を確認します。
失敗・結果不明・履歴保存失敗なら自動再送/有効化せず、`history --json --offline` と既存証拠を残します。

4. 既存フロントエンドのClerk SDKでサインイン後、sessionの `getToken()` で得たtokenを
   同じoriginの `/private` へAuthorization Bearerとして送ります。ブラウザーの通常のアプリ処理内だけで扱い、
   tokenをチャット・コマンド引数・ログへコピーしません。応答の固定resultのみを画面に表示します。
5. 別途許可された実機能確認では、サインアウト時401、サインイン時200と
   `protected-feature-accessible` をそれぞれ観測します。prepare成功だけではこの確認を完了にしません。

残る人間の操作は、必要な場合の一度の安全なキー入力、対象作用への承認とOS本人確認、
既存アプリでの通常のサインインです。この例を理由にWindows保存/削除の一式を再実行しません。
実際のClerk/Cloudflare使用条件・料金・対象アプリの許可は、live操作前にその場の状況で確認します。

## 境界と資料

これはユーザーごとのデータや権限を実装する完成品ではありません。追加の保護機能には通常の認可が必要です。
署名検証済みclaimsだけを見て、期待originのsessionとuserの存在を要求します。
SDKの `authorizedParties` だけではazpが無いtokenを拒否しないため、この例は検証済みazpの一致も確認します。
生のSDK診断やredirectヘッダーを応答へ返さず、不明な認証状態は閉じた503にします。

- [公式 authenticateRequest API](https://clerk.com/docs/reference/backend/authenticate-request)
- [公式 Workersのversions/deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/)
- [API Key Caseの限定したWorker準備契約](../../docs/design/connection-deployment.md#clerk-create-a-cloudflare-worker-version-private-candidate)

この例はprivate source toolingです。公開npm packageの新機能や全Clerkアプリ対応を意味しません。

検証記録（2026-10-04）: lockfileからのfresh offline復元後、実SDKの16ケースと
既存製品interfaceの環境別checkが通りました。Worker向けbrowser/ESM bundleも生成できました。
npmのdry-run allowlistは従来の174ファイルで、この例と依存は配布物に入りません。
製品runtime/依存/aggregate/native UIは変更していません。この例についてfull製品aggregate、
新しいWindows受入、hosted CI、実Clerk/Cloudflare操作を行ったとは扱いません。

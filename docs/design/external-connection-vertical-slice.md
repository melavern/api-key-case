# External connection vertical slice — State / Verification / Environment design

- Date: 2026-10-01
- Status: **State / provider verification / environment model closed; local application trust boundary adopted; bounded Windows local implementation enabled, with user-reported named-app send and inbox acceptance; common-experience/value comparison remains open (§22).**
- Implementation: **The development implementation includes environment separation, the bounded hosted v2 Windows path and the ordinary-file Windows local session. Windows functional acceptance was user-reported at 100% on 2026-10-02; 150% display coverage remains a public-release gate, and macOS native acceptance remains separately unverified. On 2026-10-03, the user reported one approved named-app Resend send and inbox receipt; this is scoped user evidence, not generic application completion. See [the receipt](../VERIFICATION.md#named-resend-application--user-reported-live-acceptance-2026-10-03). See [environment-credentials.md](environment-credentials.md) for the evidence and stage-based gates. No new release is claimed.**
- Product direction: owner-maintained private strategy. Current accepted candidate scope is recorded in [the release candidate guide](../releases/windows-vnext-candidate.md).
- Existing guided setup: [guided-setup.md](guided-setup.md)
- External Evidence: ../research/2026-10-01-resend-agent-setup.md (maintainer-only evidence; omitted from the public tree)

## 1. Goal

Resendの最初のVertical Sliceで、次を一続きのProduct契約として成立させる。

> Agentが外部サービス設定で止まったところから、人間に必要な操作だけを依頼し、Secret本文をAgentへ返さず、どの環境・どの接続を設定しているかを保持し、現在分かっている事実と未確認を区別して開発へ戻れること。

「Secretが保存された」を完了としない。

最終的な状態は最低でも次を区別する。

1. credentialが必要だと分かった
2. credentialが保存済み、またはprovider-native routeで管理されている
3. providerがcredentialを受理することを確認した
4. destination側の設定状態を確認した
5. application側の利用結果を確認した
6. 未確認 / 失敗 / unknown / stale

この設計はResendだけのhard-codeを増やすためではない。
一方、まだgeneric provider platformを作らない。最初の実装対象はResend 1サービス。

---

## 2. Top-level decisions

### D1. API Key Caseの正本状態を1つにしない

次の3層を分離する。

#### A. Live fact

実行時に毎回観測し直せる事実。

例:

- project内で `RESEND_API_KEY` が必要と検出された
- OS secret storeに対象credentialが存在する / しない
- Vercel project identityが現在どう解決されるか
- provider CLIが現在resolve可能か
- current source / config fingerprint

**persisted stateよりlive factを優先する。**

#### B. Durable intent

「このprojectで何を接続しようとしていたか」という非秘密の再開情報。

例:

- service = `resend`
- app environment = `development`
- connection slot = `default`
- selected route = provider-native / api-key-case-managed / manual
- destination kind = local / vercel / cloudflare / manual
- optional sending domain

これは通常fileへ保存してよいが、**authorityを持たないadvisory state**とする。
Agentがfileを書き換えてもSecret access、approval、deploy permission、verified claimを獲得できない。

#### C. Observation receipt

実際に行ったcheck / setup operationの観測結果。

例:

- Resend credential validationがpassした
- provider-native Vercel env presenceを確認した
- test sendが成功した
- application-level checkがpassした
- resultがunknownになった

receiptは過去の観測であり、current remote truthではない。
Live factやbasisが変わればstaleになる。

### D2. 「接続済み」を単一booleanにしない

`connected: true` のような状態は禁止する。

最低限、

- credential
- destination
- provider check
- application check

を別々に返す。

Product UI / Agent説明でも「保存済み」と「動作確認済み」を混同しない。

### D3. provider-native routeを第一級にする

公式integration / CLI / MCPが、API Key Case独自実装より少ない人間作業で安全に目的を達成する場合、API Key Caseはそのrouteを案内してよい。

Resend + Vercel integrationが代表例。

API Key Caseを使わせること自体をGoalにしない。

### D4. Secret本文をAgent-facing interfaceへ返さない

現行契約を維持する。

新しいstate / receipt / connection checkにも次を保存・返却しない。

- Secret value
- partial value
- value-derived hash
- length
- arbitrary provider raw output

### D5. generic secret runnerを作らない

Connection verificationのために、

- `get_secret`
- generic `withSecret(callback)`
- arbitrary command / argv
- arbitrary environment variable injection
- arbitrary URL

を公開しない。

Resend checkはclosed operationとして実装する。

---

## 3. Connection identity

### 3.1 Logical slot

最初のconnection identityは次のtupleで固定する。

```text
(project realpath, service, appEnvironment, slot)
```

MVP:

- service: `resend`
- appEnvironment: `development | preview | production`
- slot: 固定 `default`

`slot`は将来同一serviceを複数接続する場合の拡張余地。
MVP UIでは表示・編集しない。

### 3.2 connectionId

diskやAgentへproject realpathを直接持ち回さない。

```text
connectionId = sha256(
  canonicalProjectRealpath + "\n" +
  service + "\n" +
  appEnvironment + "\n" +
  slot
)
```

project identityのcase normalizationは既存 `deriveProjectId` と整合する。

### 3.3 Destination is not part of connection identity

destination変更で別connectionを新規作成しない。

例:

- local → Vercel
- Vercel project A → B

は同じconnection slotのdestination change。

変更時はdestination-dependent observationをstaleにする。

---

## 4. Durable connection state

保存先はRepository外のlocal metadataとする。

```text
~/.api-key-case/connections/<project-hash>/state.json
```

要件:

- file mode 0600
- parent directories 0700
- symlink / special file / oversized fileを拒否
- atomic temp → rename
- closed schema
- CLI/envからbase pathを変更できない
- testだけbaseDir injection可
- Secret-related dataを入れない

Schema v1 concept:

```ts
type ConnectionIntent = {
  id: string; // deterministic connectionId
  service: "resend";
  environment: "development" | "preview" | "production";
  slot: "default";
  route: "provider-native" | "api-key-case-managed" | "manual";
  destination: {
    kind: "local" | "vercel" | "cloudflare" | "manual";
  };
  sendingDomain: string | null; // non-secret; optional
  createdAt: string;
  updatedAt: string;
};
```

`sendingDomain`はuserがResend keyをdomain-restrictedにした場合やapplication checkで必要。
存在しない場合は推測しない。

このfileは**resume hint**でありpermissionではない。

---

## 5. Observation journal

Connection intentと観測履歴を同じfileへ混ぜない。

保存先:

```text
~/.api-key-case/connections/<project-hash>/observations.json
```

既存DeploymentHistoryと同じ思想を使う。

- bounded entries
- strict schema
- unknownを保持
- beginを先にpersist
- external effect後にresult persistが失敗した場合はunknown
- lockを勝手に消さない
- raw provider outputを保存しない

Concept:

```ts
type ConnectionObservation = {
  id: string;
  connectionId: string;
  kind:
    | "credential-validation"
    | "destination-check"
    | "send-capability-check"
    | "application-check";
  authority:
    | "provider-observed"
    | "local-observed"
    | "agent-observed"
    | "human-reported";
  outcome: "completed" | "failed" | "unknown";
  startedAt: string;
  finishedAt: string | null;
  basis: {
    credentialRevision: string | null;
    destinationFingerprint: string | null;
    intentFingerprint: string | null;
    sourceFingerprint: string | null;
    verifierVersion: string;
  };
  resultCode: string | null; // closed enum only
};
```

raw message、email address、Secret、provider response bodyはjournalへ保存しない。

---

## 6. Authority model in `next`

`next --json` はpersisted fileをそのまま返さない。

毎回、

1. current project scan
2. live vault existence
3. current destination/readiness
4. durable intent
5. latest relevant observation

をmergeしてsemantic stateを作る。

### 6.1 Connection report

Future schema concept:

```ts
type ConnectionReport = {
  service: "resend";
  environment: "development" | "preview" | "production";
  route: "provider-native" | "api-key-case-managed" | "manual";
  credential: {
    source: "api-key-case" | "provider-native" | "legacy-unscoped" | "unknown";
    status: "missing" | "registered" | "external-unverified" | "unavailable";
  };
  destination: {
    kind: "local" | "vercel" | "cloudflare" | "manual";
    status: "not-selected" | "prerequisites-checked" | "configured" | "changed" | "unknown";
  };
  providerCheck: {
    status: "not-run" | "passed" | "failed" | "unknown" | "stale" | "not-applicable";
    authority: "provider-observed" | "none";
  };
  applicationCheck: {
    status: "not-run" | "passed" | "failed" | "unknown" | "stale";
    authority: "agent-observed" | "human-reported" | "none";
  };
  stage:
    | "choose-route"
    | "acquire-credential"
    | "configure-destination"
    | "verify-provider"
    | "verify-application"
    | "ready"
    | "blocked"
    | "unknown";
};
```

### 6.2 `guidedSetup` compatibility

現在のschema 4 `guidedSetup` projectionはすぐ削除しない。

connection report実装後は、Resend active connectionの一部をprojectionした互換surfaceとして扱う。
別のsource of truthにしない。

---

## 7. Route selection

### 7.1 provider-native

公式integrationが接続をend-to-endで処理する場合。

Resend + Vercel integrationなど。

API Key Case:

- fixed official routeを案内
- Secretを自分のvaultへ重複保存しない
- provider-native secretを取得しない
- Vercel側のenv name / project state等、Secret本文なしに確認可能な範囲だけ観測
- credential stateは `external-unverified` になり得る
- application checkが成功すれば最終readyへ進める

### 7.2 api-key-case-managed

provider-native routeが目的に合わない、またはuserがAPI Key Case-managed pathを選ぶ場合。

API Key Case:

- Human Planeでcredential保存
- closed credential validation
- 必要なら既存deploy adapterへ渡す
- environment-scoped storage（§9）を使う

### 7.3 manual

公式routeもmanaged pathも安全に自動化できない場合。

- fixed manual guidanceだけ返す
- 完了したと推測しない
- user / Agentが後続checkを明示的に行うまでstateはunverified

---

## 8. Resend provider check

### 8.1 Read-only credential validation is the first check

最初のconnection-checkはemail送信ではない。

Official Resend CLI `resend doctor --json` を使う。

現在のCLI実装では:

- `RESEND_API_KEY` envを正式にcredential sourceとして扱う
- APIへ実際に問い合わせてcredential validityを検証する
- sending-only keyのrestricted resultをinvalidではなくwarnとして扱う

よって、以下を区別できる。

- valid full-access credential
- valid sending-only credential
- missing/invalid credential
- network/transient unknown

### 8.2 Secret injection boundary

このcheckのためにgeneric env injection helperを公開しない。

Value-bearing readは既存handoff boundaryと同じく、限られた内部moduleだけに置く。

実装上のclosed operation ID:

```text
resend-credential-validation-v1
```

このoperationだけが:

- exact resolved `resend` CLI pathを固定
- trusted execution snapshotを作る
- fresh sanitized child envを作る
- OS storeから読み出した値をchild envの `RESEND_API_KEY` にだけ設定
- argvは固定 `resend doctor --json`
- raw child envをAgentへ返さない
- stdout/stderrはSecret scrub後、closed parserを通す
- parserが理解できないoutputはunknown

を許可される。

arbitrary env name / argv / cwd / URLをcallerから受け取らない。

### 8.3 Provider check outcomes

Closed result codes:

- `valid-full-access`
- `valid-sending-access`
- `invalid-credential`
- `cli-unavailable`
- `network-unavailable`
- `unexpected-output`
- `unknown`

CLI version checkのwarnはcredential validityをfailにしない。

### 8.4 This does not prove send capability

Sending accessはdomain-restrictedになり得る。

したがってdoctor pass/warnは、

> credentialがResendに受理された

まで。

> applicationが意図したfrom addressで送れる

ことは証明しない。

---

## 9. Environment separation

### 9.1 Current v1 SecretRef is unscoped by app environment

現行:

```text
v1|project|<projectId>|RESEND_API_KEY
```

はdevelopment / preview / productionを区別できない。

新しいVertical Sliceの最終状態ではこれを使い続けない。

### 9.2 v2 connection credential slot

新規guided connection用にenvironment-aware storage accountを追加する。

Logical ref:

```ts
type ConnectionCredentialRef = {
  scope: "project";
  projectId: string;
  service: "resend";
  environment: "development" | "preview" | "production";
  name: "RESEND_API_KEY";
};
```

OS-store account form:

```text
v2|credential|project|<projectId>|resend|<environment>|RESEND_API_KEY
```

MVPでは:

- project scopeのみ
- user scopeは追加しない
- same logical nameのenvironment別valueを同時保持できる
- Agent-facing APIにgetterを追加しない

### 9.3 Legacy behavior

existing v1 secretsを削除・自動移行しない。

Connection reportでは既存v1 secretを:

```text
source = legacy-unscoped
```

と区別する。

旧command / current 0.9.x behaviorはそのまま維持する。

新しいenvironment-aware flowへ移る場合、初期版ではHuman Planeから対象env slotへ再入力する。
v1 valueを読み出してv2へ自動copyするbridgeは作らない。

理由:

- generic value-bearing migration pathを増やさない
- 既存Secretをどのenvironmentへ割り当てるかを推測しない
- 一度の再入力はmigration期だけのcostであり、Product security boundaryを単純に保てる

将来この摩擦が実測で大きければ、exact source/destinationをHuman Planeで確認するbounded adopt operationを別設計する。

---

## 10. Credential revision and staleness

Connection verificationはSecret value hashでbindしない。

代わりに、valueを含まないregistration revisionを使う。

v2 credential slotのmetadataには:

- createdAt
- updatedAt
- projectId
- service
- environment
- name

だけを持つ。

`updatedAt`が変われば以前のprovider checkはstale。

metadataがunavailable / corruptならcurrent verificationをclaimせずunknownへ落とす。

Security authorityには使わない。

---

## 11. Destination state

### 11.1 Destination kind

Connection intentに次を持つ。

- local
- vercel
- cloudflare
- manual

### 11.2 Identity

Vercel / Cloudflare等で既存destination resolverがある場合は、それを再利用する。

persisted intentにはraw account/project credentialを保存しない。

current destination fingerprintは実行時に再解決する。

last observationのfingerprintと変われば:

- destinationCheck → stale
- applicationCheck → stale

credential validity自体はdestination-independentなので、credentialが同じならproviderCheckは維持可能。

### 11.3 provider-native Vercel route

Resend Vercel integrationを使った場合:

- API Key CaseはSecretを所有しない
- Vercel側で `RESEND_API_KEY` nameの存在をread-onlyに確認できる場合のみdestination configuredとする
- value equality / credential validityはclaimしない
- app-level behaviorがpassすれば、その観測を別authorityで記録する

---

## 12. Application check

### 12.1 API Key Case does not invent generic app correctness

任意repositoryについて、

> Resendが本当にアプリから使える

ことをProduct内部だけで一般的に証明するのは不可能。

したがってapplication checkはprovider checkと別authorityにする。

### 12.2 First vertical slice

Resendでは二段階にする。

#### Provider capability

API Key Case-owned, closed operation。

- credential validation: `resend doctor --json`
- optional send capability checkは後段

#### Application behavior

Coding Agent-owned observation。

Agentが実際のprojectの既存test / local endpoint / deployed endpointを使って、ユーザーが求めたemail flowを確認する。

結果はAPI Key Caseへclosed statusとして記録してよいが、

```text
authority = agent-observed
```

を必ず保持する。

Agent-provided application passを、provider-authenticated Factやsecurity approvalに昇格しない。

### 12.3 Send capability check

必要になった場合だけ、Resend公式test recipientを使うbounded provider operationを追加できる。

- recipient: fixed `delivered@resend.dev`
- user emailを受け付けない
- selected sending domain / from addressが必要
- `--idempotency-key` 必須
- external writeとしてreceipt beginを先に保存
- unknown resultをblind retryしない
- application checkの代わりにはしない

これは `connection-check` の最初の実装には必須ではない。

---

## 13. Invalidation rules

### Credential update / delete

Affected:

- credential status → live recompute
- providerCheck → stale
- sendCapabilityCheck → stale
- applicationCheck → stale

The application observation binds to the non-secret credential registration revision. A deleted credential makes
the result stale. If the current registration revision or the saved revision is unavailable, report `unknown`.

Destination checkはcredential independentなら維持可能。

### Environment change

Environmentはconnection identityの一部。

別connection slotとして扱う。

developmentのpassをproductionへ引き継がない。

### Destination change

Affected:

- destinationCheck → stale
- applicationCheck → stale

Application observations also bind to a fingerprint of the selected intent fields (service, environment, route,
destination kind, and sending domain). A route or destination selection change makes the result stale. This intent
fingerprint is not a live provider destination identity; when the live destination identity is required but cannot
be resolved, the result must remain unknown/stale rather than be inferred from the intent.

Provider credential validationは同じcredential revisionなら維持可能。

### Relevant source change

Scannerが `RESEND_API_KEY` referenceとして扱うsource locationsから、Secret本文を含めずに非秘密のsource
fingerprintを作る。raw sourceや値をdigestへ直接入力してはならない。comment本文は除外し、ASIへ影響する改行は
block comment内も保持する。文字列・数値など挙動に影響する値や安全に分類できない構文を含むsourceはfingerprint
unavailableとして扱い、applicationCheckは `unknown` にする。

そのfingerprintが変わればapplicationCheck → stale。旧receiptなどでsource、credential revision、またはintent
basisを解決できない場合も `unknown` とし、current passを推測復元しない。

Provider checkは維持可能。

### Provider verifier version change

Provider checkのfixed operation / parser contractが変わった場合、verifierVersionを更新する。

旧receiptはhistoryとして残すがcurrent passには使わない。

### Missing/corrupt local state

intentが読めなければlive scanからguided setupを再構成する。

過去のpassを推測復元しない。

---

## 14. Stage derivation

例:

| Live / observed state | Stage |
| --- | --- |
| service intentなし | current guided setup behavior |
| route未選択 | `choose-route` |
| managed + env credential missing | `acquire-credential` |
| provider-native + human setup未確認 | `configure-destination` |
| credential registered + provider check未実施/stale | `verify-provider` |
| provider check pass + app check未実施/stale | `verify-application` |
| provider + application pass current | `ready` |
| known failure | `blocked` |
| unknown external outcome / unreadable history | `unknown` |

`ready` は、

- current environment
- current credential revision or provider-native configuration
- current destination
- current relevant source fingerprint

にbindされたpassだけで成立する。

---

## 15. nextActions authority

Connection nextActionsはclosed enumにする。

Candidate set:

- agent: `review-connection-route`
- human: `complete-provider-native-setup`
- human: `register-connection-credential`
- agent: `validate-provider-credential`
- agent: `review-destination-setup`
- agent: `verify-application-connection`
- human/agent: `resolve-unknown-connection` only with closed reason

arbitrary URL / command / argumentをnextActionsに入れない。

Official linkはbuilt-in service guideのfixed metadataからrenderする。

---

## 16. Official capability metadata

provider capabilityはruntime web searchから組み立てない。

built-in, reviewed metadataを使う。

Resend v1 metadata examples:

- API key dashboard
- official create-key docs
- official CLI
- Vercel integration
- evidence checked date
- supported routes

外部仕様は変わり得るため、Product変更時にofficial sourceを再確認する。
metadataのchecked dateが古いこと自体でruntime failureにしないが、公開claim更新前には再検証する。

---

## 17. Compatibility

### Existing 0.9.x

維持する。

- existing `save/check/list/remove`
- v1 SecretRef
- current deploy
- current history
- Human Plane
- Agent exact-version instruction
- public LP / README claims

### schema evolution

`next`へconnection reportを追加するときはschemaをbumpする。setup-state候補はschema 4で、schema 3 `guidedSetup`をcompat projectionとして保つ。

current schema 4 `guidedSetup` はcompat projectionとして残せる。
Agent instructionはexact package version pinの既存契約に従う。

### No automatic public positioning change

Vertical Sliceの設計・development実装が成立しても、LP/READMEの主Positioning変更はRoadmap `positioning-update` まで行わない。

---

## 18. Roadmap implementation boundaries

### roadmap:setup-state

Implement:

- ConnectionIntent local store
- observation journal skeleton
- connection identity
- semantic connection report
- current Resend guided setup → connection state projection

Do not implement:

- v2 env credential storage
- Resend CLI secret injection
- live provider network check
- app check execution

### roadmap:connection-check

Implement:

- closed `resend-credential-validation-v1`
- fixed official CLI resolution
- sanitized child env with only fixed `RESEND_API_KEY` secret injection
- `resend doctor --json` parser
- provider observation receipt
- staleness by credential revision / verifier version

Do not implement:

- generic env injection
- arbitrary Resend command
- email send test unless separately needed

Local candidate entry point: `api-key-case connection check --service resend --json [path]`.
It requires an explicitly selected `api-key-case-managed` intent and an existing credential;
project registration takes precedence over user registration, exactly as in `next`.
No new environment-scoped slot is created. The result has only `service`, `status`
(`valid` / `invalid` / `unknown`), a closed `resultCode`, and `recorded`.

The adapter accepts the reviewed Resend CLI 2.23.0 contract. A trusted native binary
is independent of API Key Case's Node >=20 host; a script needs a bound Node >=22
interpreter. Windows normal global npm installs bind the fixed reviewed bundle
SHA-256 and an independently snapshotted Node executable from OS-derived trusted
directories, then directly spawn Node without interpreting `.cmd`/`.bat`. A trusted
native `.exe` remains eligible. See [the exact contract and acceptance](connection-check-candidate.md).
Other/missing versions and unsupported trusted execution stay unknown; do not raise
the product Node requirement or run `resend login` as a fallback.

The sole value-bearing handoff creates an empty private provider config directory,
uses a fresh child environment, probes the fixed version before reading a key, then
runs only `doctor --json` with `RESEND_API_KEY` set in that child. `NODE_OPTIONS`,
profiles, proxies, custom URLs and inherited provider credentials are not forwarded.
The child SDK's `NODE_ENV=production` is fixed to suppress its debug error logger;
unexpected stderr remains unknown. This log mode does not change the intent's environment.
No value, masked key suffix, domain list, raw provider output or environment is in
the response/receipt. Capture is bounded; timeout/error/output drift stays unknown.

The unknown journal entry is persisted before execution. Revision, selected scope,
intent and exact executable/interpreter are rechecked before read/spawn and after
execution. Failed receipt completion returns unknown and retains the interrupted
entry. Finished credential validity binds registration revision plus the non-secret
name/scope/project identity and verifier version; destination-only changes preserve
it. Destination/app/source/send readiness and human approval remain separate.

### roadmap:environment-split

Integrated for development; the accepted functional evidence and remaining release checks are in
[environment-credentials.md](environment-credentials.md). Implemented:

- v2 project/environment credential slots
- Human Plane save/check/remove for exact env slot
- legacy-unscoped reporting
- no automatic v1 value migration
- invalidate observations correctly

### roadmap:vertical-complete

Implement:

- application check observation contract
- destination + source fingerprint invalidation
- first real Resend project flow from missing credential to provider/app check
- provider-native route support where it reduces work
- acceptance evidence on supported host

Do not add second service until this is complete.

---

## 19. Acceptance criteria before positioning update

The Vertical Slice is not complete unless all are observed.

1. New Agent chat can recover active Resend service + environment + current stage without Secret value.
2. development and production can hold different `RESEND_API_KEY` values simultaneously.
3. Updating/deleting one env credential makes only dependent observations stale.
4. Provider validation uses official Resend CLI and Secret never appears in argv, stdout, stderr, persisted state, Agent I/O.
5. sending-only valid keys are not mislabeled invalid.
6. unknown provider result is preserved as unknown and never silently converted to pass.
7. destination change makes destination/application state stale.
8. application result is labelled by authority; Agent observation is not provider truth.
9. provider-native route can finish without duplicating Secret into API Key Case where official integration already owns it.
10. existing 0.9.x save/deploy behavior remains compatible.
11. Public messaging remains old claim until an actual end-to-end supported-host acceptance is recorded.

---

## 20. Explicit non-goals

- account creation automation
- bypassing login / 2FA / payment consent
- dashboard scraping
- generic browser agent
- generic Secret getter
- generic arbitrary process env injector
- team Secret Manager
- sync across devices
- automatic migration of legacy Secret values
- second provider before Resend Vertical Slice is accepted

---

## 21. Reconsideration triggers

Reopen this design only if one of the following materially changes.

- Resend official OAuth / remote MCP removes the need for user-managed API keys in the target application flow.
- Resend / Vercel native integration can provide end-to-end application verification that makes this entire Vertical Slice redundant.
- User evidence shows environment-separated Secret storage is not needed.
- The fixed CLI verification path cannot preserve the no-secret-return boundary on supported hosts.
- Another provider becomes a substantially better first Vertical Slice before implementation starts.

Otherwise, downstream implementation should not re-decide the state authority, identity, environment slot, or verification semantics.

---

## 22. Application handoff: boundary adopted, implementation pending (2026-10-02)

Update at 18:01 UTC: the user adopted explicit project × Resend × development handoff to an app that can read
the key, without protection from app code/dependencies or the same OS user. API Key Case retains no raw value in
Agent CLI/MCP/JSON, plaintext files, argv or ordinary logs. OS vault storage remains allowed; app-owned logs are
outside this guarantee. Evidence: Sentinel_f39132f60fe4819189a391a89bfe4628 and adoption
Sentinel_88cec08e50dc81919a02d300f87102de (「まあそんな感じで進めといて」). Bounded local design/implementation
is now authorized; real key/app execution and persistent grants are not. Earlier comparison text below records
the decision context, not an instruction to keep the adopted boundary pending.

The adopted multivendor strategy standardizes the experience, not provider permissions, billing or security guarantees.
The first target remains one JS/TS application on the same Windows host, development, Resend only. Keep the portable core;
do not add a Windows-to-Ubuntu credential bridge. The target describes the desired user outcome, not approval of a new runner.

### 22.1 What the present boundary permits

The current secret-nonreturn interface can support a closed plan for an environment-scoped credential and an existing
allowlisted destination, followed by separately labelled application observations. However, the environment-separation contract explicitly rejects
v2 credentials in legacy deploy. The separate development `connection deploy` implementation now places only the exact
v2 Resend environment credential at an explicitly selected managed Vercel/Cloudflare destination under the existing guarded
engine; see [the bounded contract](connection-deployment.md). Legacy deploy still rejects v2. Saving/validating v2 alone
does not place it, and successful hosted placement does not make an application ready.

Existing Cloudflare / Vercel / GitHub adapters place secrets. They are not complete provider provisioning adapters.
Remote placement also does not fulfil a local-development target merely because the same app has a hosted deployment.

### 22.2 Options to compare before choosing a value-bearing path

1. **Official-native path.** Reuse the provider's supported integration / CLI / OAuth / binding when it best completes the
   requested environment. Do not duplicate its secret in the vault. Resend account/API-key steps, conditional DNS/domain
   setup and billing remain visible where applicable; do not claim that an integration removes them all.
2. **Scoped allowlisted deployment.** The bounded hosted development implementation can place the exact v2 service/environment credential at an already
   supported destination under its existing trust/approval rules. Record actual destination identity and app observations
   separately. This option is useful only when the intended app/environment is that destination.
3. **Bounded local-app access.** A new trust contract, not approved by the strategy alone. Before implementation, specify the
   exact app/code identity, host, development environment, credential, lifetime, launch/access method, cancellation,
   failure/recovery and output policy. Any material change of those bases invalidates permission or requires a fresh decision.
   No arbitrary command/argv/cwd/URL API, generic runner, getter, export or plaintext env-file output.

For option 3, the application can read the credential. The same OS user may also be able to access it. An Agent editing
application code can create a leak unless a separately verified execution/isolation model prevents that. A popup and
Windows Credential Manager do not prove such isolation, and Windows Hello is not required for every existing save/read.
Describe the actual guarantee as no raw value in the Agent-facing API; do not promise arbitrary-code exfiltration resistance.
Log filtering is defence in depth, not proof that arbitrary application output is safe. Do not run secret-bearing application
code or silently adopt a runner to make an end-to-end demo appear complete.

### 22.3 Secret-free implementation unit

The plan/observation implementation integrated the **closed destination plan and application-observation contract**, without reading, moving or injecting secrets:

- Use the existing Resend intent, explicit environment and allowlisted destination vocabulary; no caller-supplied URL or command.
- Keep local handoff unsupported within this generic plan contract; the separate local session is §22.8. Preserve the environment implementation's fail-closed v2 legacy-deploy behaviour; the separately bounded
  hosted entrypoint does not change the legacy handoff. A plan is neither permission nor evidence of placement.
- Observations retain `authority = agent-observed`, the exact environment, non-secret credential revision or explicit
  provider-native basis, destination identity, relevant source basis and check time. Define bounded expiry/version semantics
  before persisting a current pass; expired, missing, unreadable or unresolved basis cannot remain ready.
- Synthetic tests cover environment mismatch, changed/deleted credential, changed destination/source, wrong authority,
  expiry, malformed/missing receipt, unknown external result and interrupted recovery. No real key or email is needed.
- The result proves the contract only. It does not prove a working application, authorize a provider write, or complete
  `vertical-complete`. A new trust boundary or product-visible guarantee returns for explicit decision.

### 22.4 Roadmap gates and completion evidence

The existing human-owned `.development/roadmap.json` order is unchanged. These are acceptance details for its existing steps:

| Step | Gate |
| --- | --- |
| `environment-split` | Complete for development: environment separation integrated after required review/checks and user-reported Windows native functional acceptance (19/19 at 100%). The 150% visual matrix remains a public-release gate under [RELEASING](../RELEASING.md); unverified coverage is not a pass. |
| `vertical-complete` | Select a handoff option for the intended app/environment with the above boundary explicit; pass synthetic flow and invalidation/expiry tests; then run a separately authorized real-key/app check. Any email, destination change, billable action or publication keeps its own approval boundary. |
| `vertical-complete` value evidence | Observe the requested feature working in that app/environment and compare human effort with the best official path plus Agent/Skill. Saved credentials or recorded receipts alone do not count. |
| Before expansion / `positioning-update` | Test the common experience with a second provider and a new app after the first path is accepted. Measure relearning, repeated setup, environment errors and recovery as well as first setup time; validate paid value before making a new sales claim. |

Cloudflare D1 + Clerk + Resend and Vercel + Supabase + Resend remain proposals for later comparison, not chosen stacks.
Proposed trial sizes, durations and numeric success thresholds are not adopted commitments.

### 22.5 Environment integration record

Environment separation was integrated for development on 2026-10-02.
The integration preserves environment-specific implementation and acceptance evidence, the original Pro assessment,
the adopted multivendor strategy, and the then-pending application-handoff decision. The runtime/helper accepted on
2026-10-02 is unchanged; later edits record stage-based gates and fix a synthetic test canary. Environment completion
is not local-app or full vertical completion. The roadmap advances only to the existing `vertical-complete` step.

### 22.6 Secret-free plan / observation candidate

The development implementation implements §22.3's read-only closed plan and expiring, `agent-observed` application
receipt through the CLI and `next --json`. Production destination/native-configuration resolution remains unknown;
only synthetic fixed-identity tests exercise a complete plan. See the [exact contract](connection-plan-observation.md). Its plan has no
permission/execution authority, provider-native configuration remains explicitly observed, and local planning in this
generic contract plus v2 legacy deploy remain unsupported. The separate local session is described in §22.8. The candidate and synthetic tests do not close `vertical-complete`, change the
human-owned roadmap order, or replace real application/value acceptance. The environment implementation's native functional gate is satisfied;
its still-pending 150% visual coverage remains a release requirement.

The integrated recovery follow-up adds environment-scoped closed failure reasons and actor/action advice
to the plan and `next --json`. It distinguishes missing intent/receipt from unreadable or interrupted metadata, missing
credentials from unknown revisions, and product-owned handoff/resolver gaps from user inputs. Inspection never resets
metadata, renews evidence, retries work or grants permission; see the same candidate contract above.

### 22.7 Bounded hosted deployment candidate

The separate `connection deploy --service resend --env <environment>` entrypoint connects the exact v2 Resend slot to
an existing managed Vercel/Cloudflare destination. Its [contract](connection-deployment.md) requires execution-owned Pro,
trust and Human Plane checks, revalidation across every destructive/read/spawn boundary, suppressed provider output and
durable namespace-aware unknown/completion receipts. The new dry-run is an offline request preview with no provider
probes or metadata writes; legacy dry-run remains unchanged. Neither a plan nor receipt grants execution authority.

This is a bounded hosted placement unit, not adoption of option 3. The separately adopted LOCAL application
handoff and its bounded implementation/acceptance are described in §22.8. No source/dependency-ready status or application observation is manufactured by a
successful deployment. Read-only plan/status paths remain separate and retain unresolved production resolver/source
coverage. Full vertical completion and real application/value acceptance remain pending, with roadmap order/focus unchanged.

### 22.8 Adopted bounded local session: staged implementation

The user-adopted boundary in §22 now has a [bounded local implementation contract](local-application-handoff.md).
The first profile is one fixed Node artifact in an explicitly selected project × Resend × development session, with
fresh Windows native approval, a finite lifetime, discarded application streams and owned process-tree cleanup.
Declared build-input change detection is not complete dependency coverage or proof that the artifact came from those inputs.
The application can read the key; application/dependency/same-user leakage and revocation of a copied key are outside the guarantee.

The current development candidate implements the coordinator and a fixed native helper. The reviewed Windows-only
ordinary-file development path is source-enabled after reported Windows native lifecycle, junction rejection and
consent acceptance; see the dated evidence and remaining exact file-symlink gaps in the local handoff design.
A purchase, editable manifest, receipt or environment variable cannot change that source gate. Synthetic portable
tests and structural review alone are not a Windows functional pass. Unknown teardown retains its lock and requires owner review; no automatic stale-lock removal or retry
is claimed. On 2026-10-03 the user reported a separately approved single Resend send and inbox receipt for the named
acceptance app; see [the scoped, user-reported evidence](../VERIFICATION.md#named-resend-application--user-reported-live-acceptance-2026-10-03).
The raw host log was not independently inspected. This is one named-app observation; official-path effort comparison
and the remaining common-experience gaps keep vertical-complete open. Public release, deployment and persistent grants remain separate actions.


### 22.9 Native acceptance gate for new hosted v2 execution

The new `connection deploy` execution path is enabled only on the accepted
Windows host path. macOS/Linux execution returns the existing `unavailable`
result before project inspection, vault calls, CLI probes, approval, history or
provider effects. The private v2 handoff also refuses non-Windows callers before
input/secret use. No request, dependency option, environment variable or receipt
can override the host gate. Test-only disposable builds exercise accepted-path
logic without exporting an override in the product.

This constrains a new development path; it does not change published legacy v1
deployment, general CLI/state portability, or existing OS support promises.
The existing Pro offline preview remains portable and retains its exact-slot
presence prerequisite. That boolean check can internally read/discard the
stored value; preview performs no value-bearing handoff, provider probe,
approval, trust update or history write. It is not execution authorization.

macOS hosted native consent/security acceptance remains unverified and required
before enabling that new path. Keeping it unavailable allows reviewed Windows
development to integrate without claiming Mac acceptance or temporarily exposing
an unaccepted path. Public release and live provider/key operations remain
separately controlled.


### 22.10 Read-only plan vault access

Managed connection planning uses only the exact environment slot's boolean
presence check. It must not call the native `isAvailable()` implementation,
which tests availability by writing and deleting a probe credential. Missing
slots remain missing without legacy/environment fallback; backend read errors
remain `credential-unavailable` with no raw diagnostic output. Observation
recomputation uses the same rule.

Read-only does not mean no secret bytes are ever handled inside the native
backend: `hasSecret` may read and immediately discard a value to answer presence.
No value is returned to the Agent, persisted, handed to an app/provider, or
printed by this plan. Provider-native plans still require no vault access.

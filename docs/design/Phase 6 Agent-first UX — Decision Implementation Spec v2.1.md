# Phase 6 Agent-first UX — Decision / Implementation Spec v2.1

作成日: 2026-08-29
状態: **Design Baseline / Independent Security Review Applied / Phase A-E Implemented**

2026-09-08補足: Phase A–Eは未公開の0.9.1候補に実装済み。実装済みと実機・実Agentでの受入完了を区別する。
現行の`next`はschema 2で、[setup/readiness契約](agent-setup-readiness.md)とコードの型を正本とする。
Windows承認は[Windows本人確認の決定](windows-human-verification.md)に従い、v1にelevated brokerは導入しない。
公開までの確認は[RELEASING](../RELEASING.md)、観測結果は[VERIFICATION](../VERIFICATION.md)を参照する。

本書はPhase 6 Agent-first UXの設計判断を固定する正本である。v2の独立Security Reviewで
Confirmed / Partially confirmedとなった指摘を反映し、Rejected指摘は復活させない。

目的は「最も自動化されたSecret Manager」を作ることではない。

**Coding Agentに開発を大きく任せながら、人間がAPIキー運用について考えたりコマンドを選んだりする回数を減らし、それでもSecret値そのものと高リスク判断はAgentへ渡さないこと。**

---

# 1. Fixed User Experience

理想状態では、人間が行うことは原則3つだけ。

1. **最初に1回、Coding Agentへbootstrap promptを貼る**
2. **Secret値が必要になったとき、その値だけ入力する**
3. **高リスク操作だけYes / Noする**

これは日常操作の分類である。providerログイン・キー発行・購入/ライセンス有効化・必要なOS本人確認は
人間の準備として残り、利用者のCoding Agentが案内する。WindowsではYesの後にHelloの`Verified`が必要。

それ以外の、

* API Key Caseの導入
* 必要Secretの検出
* registered / missing確認
* 次に必要な操作の判断
* Secret追加要求
* 日常的なSecret管理
* 安全に自動化可能なdeploy

は可能な限りCoding Agent側から進める。

ユーザーにAPI Key CaseのCLIコマンドを覚えさせたり、どのコマンドを使うか選ばせない。

---

# 2. Threat Model

API Key Caseが守る主対象は、

**Secret値がCoding Agent / LLM context / tool transcript / stdout / stderr / argv / generated file等へ直接流れること**

および、

**prompt injection等によってAgentが人間の代わりに高リスク操作を承認すること**

である。

次は保証対象外。

* 同一OSユーザー権限で動く悪意ある任意コード
* keylogger / ptrace / DLL injection等
* OS Secret Storeそのものを突破できる主体
* Secretを利用するapplication code自体を悪意あるAgentが変更することによる間接的流出
* Secretを受け取ったCloudflare / Vercel / GitHub等のprovider内部

「AgentがSecret値を知らない」と「悪意あるローカルコードがSecretを絶対取得できない」は別の保証である。

---

# 3. Security Boundary

Phase 6では安全境界を2本にする。

## 3.1 Secret Value Boundary

**Secret値そのものをAgentへ渡さない。**

Agentが扱ってよいもの:

* Secret名
* required / registered / missing
* redacted findings
* scope
* deploy target
* environment
* operation result
* Human action requiredという状態

Agentへ渡してはいけないもの:

* Secret値
* Secret値の部分文字列
* Secret値のhash
* Secret値のlength
* Secretを復元するために利用可能な情報

redaction / output-withheld messageをSecret長で変えてはならない。既存deploy scrubの長さ依存messageは
Phase Dで統一する。Phase Aの新規出力には同種の分岐を作らない。

---

## 3.2 Destination Boundary

AgentにSecret値を渡さなくても、Agentがdeploy先を攻撃者側へ変更できればSecretを外部へ転送できる。

したがって、

**「値を誰に見せないか」だけでなく、「値をどこへ配置するか」もSecurity Boundaryとして扱う。**

API Key Caseはdeploy時にDestination Identityを**意味的なaccount名の解析ではなく、実行条件の
fingerprint**として解決する。providerごとの不安定な出力parserを増やさず、次の要素を最低限
含める。

* 単一の明示的project working directoryのrealpath
* destinationに影響するrepository設定の内容hash
  （例: `wrangler.toml` / `.vercel/project.json` / Git remote）
* provider認証・destinationに影響するenvironment variableの存在
* resolved provider CLIの絶対path、size、mtime、可能ならinode / file id
* target / environment / Secret名 / project identity

Destination Identityの解決、plan表示、承認、実行は、最初に固定した**同一のproject working
directory**を使用する。`process.cwd()`が検出とは別のdestinationを暗黙に決める実装を禁止する。

provider認証environment variableの値そのものや、Secret値由来のhashを保存・表示してはならない。
Agent-first automatic operationでprovider認証environment variableが存在し、安全にidentityを
固定できない場合は、値をhashして比較するのではなくfail closedまたは`actor: human`として扱う。

Agentが提示した説明文や、Agent由来のPATH / environmentで解決した表示値を信頼アンカーにしない。
API Key Case自身が、固定したworking directory、許可した実行path、sanitized / frozen environment
から解決した状態だけをplanへ使用する。

次の場合はHuman confirmationを要求する。

* 初めてのdestination
* 前回信頼したdestinationから変化した
* production
* GitHub
* destination identityを安全に確定できない

承認対象となったresolved planと実行対象は、必ず同一の**Execution Snapshot**として扱う。
snapshotにはworking directory、destination設定、provider認証environment、resolved CLI file identityを
含める。spawn直前にCLI file identityを含むsnapshotを再検証し、承認時と一致しなければ中止する。
承認後にmutableなrepository設定、environment、PATH、CLI binaryを再利用して別destinationへ
切り替えられる実装を禁止する。

Destination trust storeとExecution Snapshotの実装はPhase Dで行う。Phase Aはこの境界を先取りして
automatic deploy権限を新設せず、status-onlyのControl Planeに留める。

Phase D実装（v0.9.1 development baseline）:

* Destination Identityは、固定project realpath / target / environment / 配置先を決めるrepository config
  （path・kind・closed destination label・Secret除去済みcontent projection hash）/ 同じtrusted CLIと
  sanitized environmentで解決したprovider account identityのsha256 fingerprintとする。
  Secret名・scope・値・部分値・値由来hash・length、provider credential値とそのhashは含めない。
  provider auth fileのtimestampとresolved CLI file identityも含めない。これらはtoken refreshやCLI更新で
  変わる実行時整合の要素であり、1回の呼び出し内でPhase Cが再検証する。
* trust storeはOS secret store上のexistence-onlyレコードとする。account名は`v1|destination|<sha256>`と
  `v1|destination-slot|<sha256>`、値は固定markerで、Secret accountとは衝突しない。fileへの書き込みだけでは
  作れないことがこの選択の理由である。slotは(project, target, environment)のみを含み、初回と変化後の
  区別だけに使う。
* trust recordはapproval token / deploy permission / Secretへのaccess権ではない。engineは毎回destinationを
  再解決し、operation policyを再適用し、spawn直前にExecution Snapshotを再検証する。CLI flag、MCP parameter、
  environment variable、stdinからtrustを作成・更新する経路は存在しない。

---

# 4. Architecture

Phase 6の基本構造を以下とする。

```text
Coding Agent
     │
     ▼
Agent Control Plane
 agent-init
 next --json
     │
     ├── safe / automatic action
     │          ↓
     │       Existing Core
     │
     └── human interaction required
                ↓
           Human Plane
          ├ Secret input
          └ Approval
                ↓
        Vault / Deploy Engine
```

MCPを必須経路にはしない。

CLI / CoreをAgent Control Planeとして使用し、MCPはoptional interfaceとして維持する。

新しい大きな概念は原則として、

1. **Agent Control Plane**
2. **Human Plane**
3. **Destination Boundary**

だけとする。

既存scanner / vault / adapters / deploy engine / handoffを最大限再利用する。

---

# 5. Agent Control Plane

## 5.1 `agent-init`

初回bootstrapの入口。

Coding Agentは最初に一度だけ `agent-init` を実行する。

`agent-init` の仕事:

* API Key CaseのAgent operation protocolをその場でAgentへ返す
* repositoryへ最小のpersistent instructionを配置する
* 次回以降、Secret/API key/deploy関連作業でAPI Key Caseを使うことをAgentへ知らせる
* ユーザーにMCPの手動設定を要求しない

persistent instructionは巨大なmanualにしない。

原則として伝えることは、

* Secret関連ではAPI Key Caseを使う
* `next` から判断する
* Secret値をchatへ要求しない
* `.env`等のSecret-bearing fileを読まない
* Human actionをAgent自身で代行しない

程度に留める。

Product protocolの正本はrepository側の文章ではなくAPI Key Case package側に持つ。

これにより将来API Key Caseの内部commandが増えても、各repositoryのinstructionを書き換える必要を減らす。

Phase Aの書き込み規則:

* project rootは開始時に1回だけrealpathへ解決し、書き込み先は固定relative pathのallowlistに限る
* 書き込み前に既存path componentを`lstat`し、file symlink / directory symlink / junctionを拒否する
* 解決後のtargetまたはparentがproject root外なら拒否する
* `scanner.ts`の`writeGeneratedFile --force`はsymlinkを追従し得るため、そのまま流用しない
* managed markerが片側だけ、重複、逆順、または本文drift状態ならfail closedし、既存内容を変えない
* `agent-init --check`は書き込みをせず、managed blockの欠落・drift・unsafe pathを検出する

---

## 5.2 Persistent Agent Knowledge

対応hostごとの**既存marker**を利用する。Phase Aでは、`AGENTS.md`があればそこだけを正本にし、
`CLAUDE.md`が`@AGENTS.md`をimportしていれば重複書き込みをしない。独立した`CLAUDE.md`や既存の
`.cursor/`がある場合だけ、そのhostのmanaged instructionを生成する。host markerが1つも無い
repositoryへhost固有fileを推測生成しない。この場合AC-1はstdout protocolで成立するが、AC-5は
安全側へdegradeしたことを結果に明示する。

既存ファイルを変更する場合はmanaged blockを使用し、その外側を変更しない。

managed blockの実行versionは、`agent-init`を実行したpackageのexact versionへpinする。Phase A実装時の
v0.9.1では`api-key-case@0.9.1`とし、`@latest`、無指定version、major lineへのfloating pinをpersistent
instructionへ焼き込まない。これにより後続のpre-stable minor releaseが既存repositoryのAgent protocolを
無条件に変更することを防ぐ。意図して更新する場合は、新しいversionの`agent-init`を再実行する。

global user configurationへの書き込みをdefaultでは行わない。

MCP configurationはPhase 6の必須条件にしない。

---

# 6. `next --json`

AgentがAPI Key Caseのcommand体系を理解しなくてもよいように、**「今何をすべきか」を返す単一入口**を作る。

概念:

```text
api-key-case next --json
```

既存の、

* scan
* vault status
* required secrets
* target detection
* license status
* deployment policy

等を合成する。

出力はstatus-only。

以下はPhase A導入時のschema version 1の**履歴例**であり、現行出力ではない。
現行schema 2は`host`、`setup`、`targets[].readiness`を追加し、`install-target-cli`を`actor: agent`へ変更した。
現行の完全な型は[`NextReport`](../../packages/core/agent/next.ts)、意味と検証限界は[setup契約](agent-setup-readiness.md)を参照する。
schema 1の例へ新しいfieldだけを継ぎ足して現行protocolとして扱わない。

```json
{
  "schemaVersion": 1,
  "vault": {
    "status": "available"
  },
  "license": {
    "plan": "free"
  },
  "hygiene": {
    "gitignoreOk": true,
    "possibleExposure": false
  },
  "secrets": [
    {
      "name": "RESEND_API_KEY",
      "scope": "project",
      "status": "registered"
    },
    {
      "name": "PADDLE_API_KEY",
      "scope": "project",
      "status": "missing"
    }
  ],
  "targets": [
    {
      "id": "cloudflare",
      "detected": true,
      "cliStatus": "ready",
      "deployment": {
        "automatic": [],
        "humanApproval": ["production", "preview", "development"],
        "destinationTrust": "not-applicable"
      }
    }
  ],
  "nextActions": [
    {
      "actor": "human",
      "kind": "register-secret",
      "name": "PADDLE_API_KEY",
      "scope": "project"
    }
  ]
}
```

続くenum/actionの列挙もPhase AからEへの変更履歴である。現行schema 2では`cliStatus`へ`unverified`、
actionへ`review-deploy-setup`も追加済みで、`install-target-cli`はAgentの準備作業に移っている。
以下の旧unionを現行コードへコピーしない。

Phase Aでは`vault.status`は`available | unavailable`、Secret statusは
`registered | missing | unavailable | unsupported`、targetの`cliStatus`は
`ready | missing | unauthenticated`のclosed enumとする。Secretはproject scopeを先に確認し、
無ければuser scopeを確認する。どちらにも無ければproject scopeの`missing`として返す。

Phase Aの`nextActions`は次のclosed unionだけを返す。

* `actor: agent`, `kind: fix-gitignore`
* `actor: human`, `kind: review-possible-exposure`
* `actor: human`, `kind: enable-vault`
* `actor: agent`, `kind: review-secret-name`, `name`
* `actor: human`, `kind: register-secret`, `name`, `scope`
* `actor: human`, `kind: install-target-cli`, `target`
* `actor: human`, `kind: authenticate-target-cli`, `target`

Phase Dで次の1件を追加する。

* `actor: human`, `kind: approve-deploy-destination`, `target`, `env`

Phase Eで次の2件を追加する。どちらも破壊的またはsecurity state変更なので`actor: agent`にしない。

* `actor: human`, `kind: remove-secret`, `name`, `scope`
* `actor: human`, `kind: forget-deploy-destination`, `target`, `env`

同時にSecret statusへ`unused`を追加する。`unused`は「project scopeのOS secret storeに存在するが、
projectがもう参照していない」cleanup候補を指し、削除ではない。候補名はvault indexから取り、
存在判定はstoreで行う。indexにだけ残る行、closed validationを通らない名前は候補にしない。

同時にtargetへ`deployment`を追加する。`automatic`は「いまAgentが人の操作なしで配置してよいenvironment」、
`humanApproval`はそれ以外で、両者はclosed environment enumを常に分割する。`destinationTrust`は
`trusted | unconfirmed | changed | unresolved | not-applicable`のclosed enumとする。destination解決は
provider CLI呼び出しを伴うため、automatic対象envを持つtargetがdetectedかつCLI readyで、planがproで、
vaultが利用可能なときだけ行う。これはstatus専用であり、trust recordを読むことはできても作成・変更はできない。

actionに`command` / `argv` / `message` / URL等の自由な実行値を含めない。Secret値、部分値、
値由来hash、length、finding preview、license entitlement ID、project IDも含めない。
Secret名は既存のclosed validation、target / scope / actor / kindはsource内のclosed enumに従う。

target statusはPhase Aではadvisoryであり、Agent由来PATH / environmentによって偽装され得る。
Human approvalの信頼アンカーには使用しない。Destination trustが未実装のPhase Aでは
`deploy` actionを`actor: agent`として返さず、新しいautomatic deploy権限を作らない。

### `actor: agent`

人間の追加判断なしにAgentが完遂してよい。

### `actor: human`

Human Planeで人間の入力または判断が必須。

AgentがHuman Plane起動要求を行うこと自体は許可してよい。

しかしAgentがSecret値やapproval responseを供給して完遂できてはならない。

重要なのはinstruction遵守ではなく、

**Agentが`actor: human`を無視して直接commandを呼んでも安全境界を突破できないこと。**

---

# 7. Human Plane

人間専用interactionをAgentのI/O経路から分離する。

## 7.1 Secret Input

Agent-owned PTY / stdin / MCP / browser form等へSecretを入力しない。

PTYのechoを消しても、PTY masterを持つ親processからSecret入力を隔離できるわけではない。

Human PlaneはAgent process treeの通常I/Oとは異なる入力面を使用する。

現行interface（型定義の正本は[`packages/core/human/types.ts`](../../packages/core/human/types.ts)）:

```ts
type HumanSecretInputStatus = "saved" | "cancelled" | "unavailable";
type HumanApprovalStatus = "approved" | "declined" | "unavailable";
type HumanPlaneCapability = "os-dialog" | "handoff-only";

interface HumanPlane {
  capability(): HumanPlaneCapability;
  askSecret(ref: SecretRef): Promise<HumanSecretInputStatus>;
  askApproval(plan: ApprovalPlan): Promise<HumanApprovalStatus>;
  askRemoval(plan: RemovalPlan): Promise<HumanApprovalStatus>;
}
```

重要:

**`askSecret()`はSecret値を返さない。**

Human Plane implementation内部で直接OS Secret Storeへ書き込む。

親processへ返るものはsaved / cancelled等の状態だけ。

Secret値をIPC response / stdout / argv / envへ戻さない。

---

## 7.2 Human Plane backend

v1優先順位:

### Windows / macOS

安全性を確認できるOS-native / detached human interaction surfaceを第一候補とする。

Secret keystrokeがAgent-owned stdin / PTYへ流れないことを検証する。

helperをAgent由来PATHから解決してはならない。OS固定の検証可能な絶対pathを使用し、helperへ渡す
environmentをallowlist方式でsanitizeする。少なくともAgent由来の`PATH`、`NODE_OPTIONS`、
`DYLD_*`、`LD_PRELOAD`等、helperの解決・code injection・destination/authenticationへ影響する値を
継承させない。project path等をshell sourceへ文字列連結せず、検証済み引数として渡す。

### Linux

安全なGUI ownershipを保証できない場合、無理にGUIを実装しない。

その場合はhandoff-onlyへfail closedする。この規則はLinux固有ではなく、Windows / macOSでも
固定pathとsanitized environmentを保証できない条件に適用する。

「全OSで3操作を実現する」ために境界を弱めない。

Human Plane実装状況（macOS boundary extension）:

* Windows: `save <NAME> --ask`が、検証済みのOS固定Windows PowerShell絶対pathからpassword dialogを開く。
  helperはtrusted directoryをcwdとし、`SystemRoot` / `WINDIR`だけの新規environment、ignored stdioで動作する。
  値はhelper内部からCredential Managerへ直接書き込み、親processへはexit statusだけを返す。
* macOS: root-ownedかつgroup/world-writableでない固定`/usr/bin/osascript`を検証し、空の新規environment、
  fixed cwd、ignored stdioでJXA/AppKit dialogを開く。Secret値は同じhelper process内からSecurity.frameworkの
  generic-password entryへ直接書き込み、既存Vaultと同じservice/accountを使用する。親processへはexit statusだけを返す。
* Linux: 現時点ではhandoff-only。Agent-owned PTYへfallbackしない。
* Windows / macOSでも固定helper pathまたはGUI sessionを利用できない場合はhandoff-onlyへfail closedする。

このplatform差は本節のfallback policyを具体化したものであり、Phase CのapprovalやPhase DのDestination
Boundaryを先取りしない。

---

## 7.3 Existing Human CLI

人間が自分で起動した従来の `save` flowは維持可能。

ただし、

**Agent-first flowからSecret inputをAgent-owned PTYへfallbackしてはいけない。**

GUI Human Planeを安全に利用できない場合は、人間自身のterminalへhandoffする。

---

# 8. High-risk Approval

production / GitHub等のHuman confirmationをAgent-owned stdinから取得しない。

現状のexact `yes` + TTYはHuman Presenceの証明にならない。

Phase 6では、

**Agent-first high-risk approvalのstdin経路を廃止する。**

Human Planeが利用できる場合:

```text
OPENAI_API_KEY
→ target
→ account / project / repository
→ environment

[No] [Yes]
```

を表示する。

Human Plane自身が承認されたoperationを実行する、または同じtrusted execution boundary内で完遂する。

承認表示と実行は§3.2の同じExecution Snapshotを共有する。承認後、spawn直前にworking directory、
provider認証environment、destination設定、resolved CLI file identityのいずれかが変わっていれば
承認済みとして扱わず中止する。

次は禁止。

```text
Human approves
→ approval tokenをAgentへ返す
→ Agentがtoken付きでdeploy
```

再利用可能なapproval tokenを作らない。

---

# 9. Headless / SSH Policy

Phase 6 v1ではsecurityをUXより優先する。

Human Planeを安全に提供できない環境では、

**高リスク操作をfail closedする。**

旧stdin approvalへ自動fallbackしない。

SSH / headless / devcontainer等への完全対応はPhase 6 v1必須条件にしない。

将来必要性が確認された場合、

`attend`等、人間自身が起動する専用approval consoleを別設計として検討する。

常駐daemon / local IPCはPhase 6 v1には入れない。

---

# 10. Deploy Policy

Agent-first modeではdeploy先ごとの実際のSecret retrieval特性も考慮する。

`--force`等、provider側の既存値の削除・上書きを伴う操作は`actor: agent`の自動実行対象にしない。
Cloudflareの常時上書き、Vercelのremove pre-stepを含め、Human confirmation対象として扱う。

## Cloudflare

non-productionでDestination Identityが既知・変更なし、かつprovider側の既存値を上書きしないことを
構造的に保証できる場合だけ自動化候補。現行`wrangler secret put`は上書きになり得るため、Phase A / Phase Dの
どちらでもautomatic actionにしない。上書きしない保証をprovider側から得られるまでこの判断を変えない。

production / destination changeはHuman confirmation。

## GitHub

環境を問わずHuman confirmationを維持する。

CIから利用可能になるため、自動deploy対象にしない。

## Vercel

### preview

Destination Identityが既知・変更なしで、provider側からSecret値を読み戻せないことを現在仕様で確認できる場合のみ自動化候補。

読み戻し不可はVercel側やteam側のdefaultに依存させない。Vercelではsensitivityがenvironmentとは
独立した設定であり（`--no-sensitive`が存在し、CLIのdefaultも変遷している）、API Key Case自身が
`vercel env add <NAME> preview --sensitive` としてwrite-only storageを明示的に要求する。
automatic safe allowlistの各entryがsensitiveをplanしていることはtestで固定する。

### production

Human confirmation。ただし配置される値はSecretなので、`preview`と同じく`--sensitive`を明示する。

### development

**Agent-first automatic deploy対象外。**

Vercel developmentはAPI仕様上sensitiveにできず（`--sensitive`はerrorになるため付けない）、
値を後から取得できる経路が存在するため、

```text
Agent
→ API Key Case deploy
→ Vercel development
→ Agentが値を再取得
```

というValue Boundary迂回が成立し得る。

Human Plane対象とし、利用不能ならfail closedする。

公開前にproviderの現行仕様を再確認する。

---

# 11. Remove / Secret Lifecycle

最終UXでは、

> 「Stripeはもう使わないから消して」

等の自然言語からAgentがSecret整理まで進められることを目標とする。

ただしSecret deletionは破壊的操作なので、

Agentが勝手に削除完遂できる設計にはしない。

`next`がcleanup候補を提示し、Human Planeで対象Secretを確認してから削除する方式を第一候補とする。

MCPへ`remove_secret`を追加すること自体はPhase 6必須ではない。

CLI Control Planeで成立するならMCP surfaceを増やさない。

Phase E実装（v0.9.1 development baseline）:

* `remove <NAME>`はPhase B/CのHuman Planeで判断する。`--yes`とstdin確認経路を廃止し、
  Agent-owned stdin / PTYから削除を完遂できる経路を残さない。Human Planeを利用できない場合は
  fail closedし、人がOS secret store自身のUIで削除する案内だけを表示する。
* storeに値が無く、indexにだけ行が残る状態はSecret削除ではなくmetadata整理として扱い、dialogを開かない。
  どちらにも無い名前はerrorとする。
* destination trust cleanupは`trust status`（読み取り専用）と`trust forget`（Human Plane必須）の2つとする。
  trustを忘れる操作は「次回また人へ聞く」方向にしか働かないが、security state変更なので`actor: agent`に
  しない。Agentが任意にtrustを消せると、人がYesを押すまでapproval dialogを出し続けられる。
* `trust forget`は、slot fingerprint（provider呼び出し不要）と、解決できた場合のdestination fingerprintを
  削除する。destinationを解決できない場合はslotだけ削除し、確認recordが残り得ることを明示してnon-zeroで終わる。
* expiry、自動cleanup、一括削除、MCP surfaceの追加は実装しない。

---

# 12. MCP Policy

既存MCPのSecret Value Boundaryを維持する。

* Secret value parameterを追加しない
* Secret valueをresponseへ返さない
* production / GitHubのMCP self-approvalを許可しない
* MCP elicitationをSecret input / approval boundaryとして使わない

MCPはAgent Control Planeのoptional optimization。

Agent-first UXを成立させるための必須依存にはしない。

---

# 13. Supply-chain / Bootstrap

Agentに`npx`実行を依頼する以上、package resolution自体がattack surfaceになる。

独立review後の運用変更として、persistent instructionは**exact version pin**を採用する。現行v0.9.1では
`npx -y api-key-case@0.9.1 next --json .`とし、`@latest`、無指定version、major lineへのfloating pinを
永続化しない。pre-stableな0.xでは後続minor versionも実装変更になり得るため、更新は明示的な
`agent-init`再実行でだけ行う。

生成元のexact versionはmanaged blockのmetadataと実行resolutionの両方で一致させる。
`agent-init --check`は、marker構造、managed本文のcontent hash、exact version、unsafe pathをno-writeで
検査する。versionが異なる未改変blockは`outdated`として扱い、通常の`agent-init`再実行時にだけ
managed blockを安全に更新する。

Product UXとしては、

**ユーザーがversion管理を考えなくてよい**

ことを目標とする。

ただしそれを理由にsupply-chain boundaryを弱めない。

bootstrap prompt自体でどのversionを最初に取得するかは人間が選べるが、その一度の選択を
persistent instructionへ無条件にコピーしない。

---

# 14. Acceptance Criteria

## AC-1 Bootstrap

ユーザーがCoding Agentへ1回bootstrap promptを貼れば、そのsessionでAPI Key Caseを利用可能になる。

## AC-2 No manual integration setup

ユーザーへMCP config編集等の追加setupを要求しない。

Coding Agent host自体のshell execution approval等はAPI Key Caseが回避しない。

## AC-3 Secret input

AgentがSecret不足を判断でき、人間はSecret値そのものだけをHuman Planeへ入力する。

値はAgent I/Oへ流れない。

GUI非対応環境では安全側へ劣化可能。

## AC-4 Approval

高リスク操作では人間がplanを確認してYes / Noを選び、OS本人確認が必要な環境ではそれも行う。
Windowsではplanボタンだけで承認せず、Helloの`Verified`以外をすべてfail closedする。

Agent-owned stdin / PTYへ`yes`を書き込むだけでは突破できない。

同一OSユーザーで動く悪意ある任意コードに対する完全防御は要求しない。

## AC-5 Persistence

2回目以降は原則bootstrap prompt不要。

repositoryに残る最小instructionからAgentがAPI Key Case利用を認識できる。

## AC-6 Lifecycle

追加・確認・配置・不要Secretの整理等を、ユーザーがAPI Key Caseのcommand体系を知らなくても扱える。

## AC-7 Destination Safety

Agentがrepository config / git remote / provider認証environment / working directory / CLI binary等を
差し替えるだけで、既存Secretを未承認destinationへ移動できない。

## AC-8 Provider Retrieval Safety

API Key Case経由で配置したSecretを、その直後にAgentがproviderの通常CLI/APIから読み戻せる既知経路がある場合、そのdeployを自動安全操作として扱わない。

---

# 15. Mandatory Security Tests

実装完了条件には最低限以下を含める。

1. fake canary Secretがstdout / stderr / JSON / MCP / generated files / telemetryへ一度も出ない
2. Agent-owned PTYからSecret inputを観測可能であることを再現し、その経路をHuman Planeが使用していない
3. synthetic `yes` / fake PTYでhigh-risk approvalを突破できない
4. `actor: human` actionをAgentが直接実行してもHuman Planeを迂回できない
5. destination設定変更（repository fileおよびprovider認証environment）後に未承認Secret deployを完遂できない
6. approval時と実行時のworking directory / environment / resolved CLI file identity不一致を検出し中止する
7. Vercel development等、provider側からread-back可能な経路をAgent automatic modeで許可しない
8. `agent-init`がmanaged block外の既存user contentを変更しない
9. symlink / path traversal等でproject外instructionを書き換えない
10. Human Plane cancellation / repeated requests / dialog spamで安全境界が変化しない
11. PATH先頭の偽helperがHuman Planeとして起動されず、unsafe条件ではhandoff-onlyへfail closedする
12. `agent-init --check`がmanaged blockの欠落・drift・unsafe pathをno-writeで検出する
13. `next --json`のschemaがclosedで、Secret値・部分値・値由来hash・length・自由な実行commandを含まない
14. 初回destinationは自動でtrustedにならず、Human Planeを通らずtrust recordを作れない
15. destination identityが一致する場合だけtrustを再利用でき、repository config / git remote /
    provider destination config / provider identity / project directory / cwdの変化で無効になる
16. CLI identityの更新ではdestination trustを失わないが、trust判定後にCLIが差し替えられた実行は中止する
17. trust済みでもproduction / GitHub / Vercel development / `--force` / `--scope user`はHuman Plane必須
18. trust store側にSecret値・部分値・値由来hash・lengthが入らない
19. MCP / stdin / environmentからtrustを作成・変更・削除できない
20. AgentだけではSecretを削除できず、refusal / cancel / Human Plane不在ではSecretが残る
21. 削除後は`check` / `next --json`がmissingへ戻る
22. Agentだけではdestination trustを削除できず、削除後は次回destinationが再確認対象になる
23. lifecycle JSONにSecret値・部分値・値由来hash・length・trust credential・destination fingerprintが出ない

---

# 16. Non-goals — Phase 6 v1

Phase 6 v1では以下を作らない。

* 新しい独自Vault
* remote cloud service
* permanent daemon
* long-lived local IPC
* browser-based Secret form
* MCP elicitationによるSecret入力
* reusable approval token
* Claude/Cursor/Codex専用plugin
* team / RBAC / rotation platform
* arbitrary deploy target
* full malicious-local-process isolation
* fully autonomous production deploy

---

# 17. Proposed Minimum Implementation Order

実装詳細はCoding Agentへ委ねるが、依存関係としては以下を基本とする。

### Phase A — Control Plane

* `agent-init`
* persistent instruction
* `next --json`

v2.1で実装済み。Secret値を扱わないstatus-only Control Planeだけを完成させる。

### Phase B — Human Plane / Secret

* Human Plane abstraction
* Secret input
* direct keyring write
* fallback policy

v2.1で実装済み。`register-secret` semantic actionはexact-version persistent protocolから薄い
`save <NAME> --ask`入口へ対応付ける。Secret値を返すAPI、daemon、long-lived IPCは追加しない。

### Phase C — Human Plane / Approval

* stdin approval廃止
* approval UI
* exact operation execution

### Phase D — Destination Boundary

* Destination Identity
* trusted destination/change detection
* TOCTOU対策
* target別automatic policy

Vercel development禁止は§10のpolicyとして固定済みであり、Phase Dではその強制を実装する。

v2.1で実装済み。automatic policyはdeny by defaultとし、closed allowlistは
「Vercel `preview` / `project` scope / `--force`なし / overwrite・preStepなし」の1件だけとする。
`production`、GitHub、Vercel `development`、`--force`、`--scope user`、未trust・変化済み・曖昧なdestination、
provider認証environmentの存在は、すべてPhase C Human Planeへ回すかfail closeする。

### Phase E — Lifecycle

* removal / cleanup
* `next` action expansion

v2.1で実装済み。§11の実装節を参照。Secret削除とdestination trust削除はHuman Plane必須とし、
`next`は候補提示だけを行う。expiry / 自動cleanup / 一括削除 / MCP surface拡張は入れない。

各Phaseごとにsecurity testsを通す。

一括で巨大改修しない。

---

# 18. Review Gate

本Specは実装前に独立Security Reviewを必須とする。v2.1では
`docs/design/独立レビュー.md`のConfirmed / Partially confirmed findingsを反映済みである。

Reviewerの仕事は新しいProduct方向を考えることではない。

以下だけを行う。

* この設計でSecret Value Boundaryを迂回できる経路を探す
* Human Planeが本当にAgent I/Oから独立しているか疑う
* approval bypassを探す
* Destination Boundaryの抜けを探す
* provider read-back経路を探す
* supply-chain / managed instruction / GUI helperで新たに生まれるattack surfaceを探す
* UX要求とSecurity requirementが矛盾している箇所を指摘する
* 過剰設計になっている箇所を指摘する

Reviewerは、問題がない部分まで別アーキテクチャへ作り直さない。

重大問題がある場合、

1. exploit / failure scenario
2. severity
3. affected requirement
4. 最小修正案

の順で報告する。

Review後にCritical issueを解消してから実装へ進む。Rejected findings（scan previewの部分値、
`next`集約自体のBlocker化、Secret名の制御文字、MCP approval bypass、save argv経路）は、コード根拠が
無い限り復活させない。

---

# 19. Phase A-E Boundary / Acceptance Status

Phase Aの実装到達点:

* **AC-1**: `agent-init`が同じsessionのstdoutへ固定operation protocolを返し、直後から`next --json`を使える
* **AC-2**: MCP、global config、daemon、IPCを要求しない
* **AC-5**: 既存host markerがあるrepositoryでは最小managed blockを残し、次回Agentが`next`を入口にできる

host markerが無いrepositoryでは、無関係なhost fileを推測生成しないためAC-5だけ安全側へdegradeする。
結果はstdoutと`--check`で明示する。

Phase Bの実装到達点:

* **AC-3**: Agentは`register-secret`を判定し、Windowsでは人間が値だけをpassword dialogへ入力する。
  helperがOS Secret Storeへ直接保存し、Agent側へ値を返さない
* GUI helperを安全に構成できないplatform / environmentはhandoff-onlyへdegradeし、Agent-owned PTYへ
  fallbackしない
* MCP `save_secret`は値parameterを持たずvaultを呼ばないまま、同じHuman Plane actionへ案内する

Phase B完了時点で未達のまま残していたもの:

* AC-4のproduction / GitHub approval Human Plane → Phase Cで達成
* AC-6のremove / cleanup expansion → Phase E
* AC-7のDestination trust store / Execution Snapshot enforcement → Phase Dで達成
* AC-8のprovider read-back policy enforcement → Phase Dで達成

Phase Dの実装到達点:

* **AC-7**: 実行されるdeployは必ず1つのDestination Identityへ束ねられ、repository config / git remote /
  provider destination config / provider identity / provider認証environment / project directory / cwdの
  いずれかをAgentが変えるだけでは既存trustを流用できない。解決できない・曖昧・矛盾する場合はfail closed。
* **AC-8**: provider側からread-back可能な経路（Vercel `development`）はautomatic safe扱いにしない。
  overwrite・削除を伴う操作も同様。
* **AC-6**はPhase Dでは未達。trust recordの削除・整理もPhase Eで達成する。

Phase Eの実装到達点:

* **AC-6**: Agentは`next --json`だけでcleanup候補（`status: "unused"`、`kind: "remove-secret"`）と、
  変化した確認済み配置先（`kind: "forget-deploy-destination"`）を判断できる。CLI体系を知る必要はない。
* 実削除は`remove`と`trust forget`の2つだけで、いずれもAgentから独立したHuman Planeを通る。
  提案（`next`）と実行（Human Plane）は分離しており、Agentが両方を満たす経路は存在しない。
* Phase A〜Dの境界（Secret Value Boundary / Human Plane / Destination Boundary / high-risk approval /
  deny-by-default automatic policy / MCP boundary / exact-version protocol）は変更していない。
  automatic-safe allowlistもVercel `preview`の1件のまま。
* macOS Human PlaneはWindowsと同じstatus-only interfaceへ追加され、`remove`と`trust forget`も同じ
  Agent-independent dialogを通る。LinuxのHuman Planeは引き続き未実装であり、Linux hostではfail closedする。

trust storeがあることを理由にPhase Cのhigh-risk approvalを省略しない。high-risk classでは
`automatic`判定に入らないため、trust stateの参照自体が行われない。

実行されるdeployのtrusted CLI resolutionは、Windowsではregistry、macOSではOS user databaseから得たhomeと
architecture-awareな閉じた候補pathを使う。どちらもcallerの`PATH` / `HOME` / provider credential environmentを
信用せず、exact CLIとsanitized environmentをExecution Snapshotへ固定してspawn前に再検証する。Linuxは
`--dry-run`以外fail closedし、providerの手動手順を表示する。

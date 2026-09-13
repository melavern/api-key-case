# Windows Human Plane 本人確認境界

> 状態: **v1の方式として確定**。Windowsのhigh-risk decisionは commit `3f87fdb` の
> プロセス内OS本人確認（`IUserConsentVerifierInterop`）を採用する。elevated broker方式は
> 隔離PoCで2 Decision Pointとも条件付き成立したが、**v1では採用しない**。理由と
> 判断の根拠は §7。実測は `docs/VERIFICATION.md` を正とする。

## 1. 修復対象

`docs/linux-support-research` ブランチの commit `e89908b` に記録された D-W では、同一Windows
ユーザー・同一sessionのmedium integrity `powershell.exe` が、入力注入を使わずMSAA
`IAccessible.accDoDefaultAction`だけでWinFormsのYesを押し、実製品の
`WindowsHumanPlane.askApproval()`を`approved`へ到達させた。password fieldは
`STATE_SYSTEM_PROTECTED`で値を返さず、Secret本文境界は保持された。

したがって修復対象はSecret inputではなく、approval / Secret removal / destination-trust removalの
「WinForms button actionを人間の意思としていた」部分である。

## 2. 採用した境界

Windowsでは既存の固定
`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`、固定cwd、allowlist env、
ignored stdio、status-only exit codeを維持する。置換可能なnpm同梱helper binaryは追加しない。

plan / removal dialogのYes・Deleteは承認ではなく、次のOS本人確認を開始する操作に変更する。

1. WinFormsのowner `HWND`を取得する。
2. 同じ固定PowerShell process内からWinRT ABIのactivation factoryを開く。
3. [`IUserConsentVerifierInterop::RequestVerificationForWindowAsync`](https://learn.microsoft.com/en-us/windows/win32/api/userconsentverifierinterop/nf-userconsentverifierinterop-iuserconsentverifierinterop-requestverificationforwindowasync)
   にowner `HWND`と、対象名・target・environmentを含む固定形の確認messageを渡す。
4. [`UserConsentVerificationResult`](https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.ui.userconsentverificationresult)
   が`Verified`の場合だけhelper exit 0を返す。
5. `Canceled`はdeclined、`DeviceNotPresent` / `NotConfiguredForUser` / `DisabledByPolicy` /
   `DeviceBusy` / `RetriesExhausted` / unknown result / WinRT errorはunavailableへ閉じる。

MicrosoftのWin32 ABI例も、activation factoryからinterop interfaceを取得し、owner `HWND`付きで
同methodを呼ぶ形である: [Using the UserConsentVerifier from a Win32 program](https://devblogs.microsoft.com/oldnewthing/20240925-00/?p=110312)。

## 2.1 表示（言語と外観）

承認画面は人が読んで判断する最後の面なので、表示条件も境界の一部として固定する。

- 言語はhelper内で `CultureInfo.CurrentUICulture` と `CurrentCulture` から決める。どちらかが
  日本語なら日本語、それ以外は英語。日本語話者が表示言語だけ英語のWindowsを使う構成は珍しくないため、
  地域設定も判定に含める。
- 環境変数（`LANG`等）は判定に使わない。helperのenvは固定allowlistであり、Agentが渡す文字列で
  人間に見せる文面を切り替えられないようにする。両言語の文言はどのscriptにも埋め込み、
  選択だけを実行時に行う。
- 文言は固定の対訳表とし、可変部分はSecret名・target・environment・path等の既存の検証済み値だけに限る。
  `psTextLiteral` のエスケープと改行禁止は両言語へ等しく適用する。
- `Application.EnableVisualStyles()` はcontrol生成前に呼ぶ。呼ぶ位置が遅いと現行テーマが当たらない。
  formのfontは `Segoe UI` 9ptとし、WinForms既定のMicrosoft Sans Serif 8.25ptを使わない。
  DPI awarenessは導入しない（承認helperへP/Invokeを増やすコストに見合わない）。dark modeも同様に扱わない。
- MSAA検証ドライバは、製品windowのcaptionとbutton名を両言語の候補で探す。候補を広げても対象は
  今回起動したhelperのPIDに束縛したままにする。
- 表示を変更したら §6 の実機4モードを再実行する。文面の変更は承認境界の変更として扱う。

## 3. Windows versionへの影響

Microsoftのdesktop interop methodの最低要件はWindows Build 22000である。このためWindows側の
対応範囲を機能単位で分ける。

- Windows 11 Build 22000以降 かつ Windows Helloが当該アカウントに設定済み:
  OS本人確認が`Verified`ならapproval/removal成立。
- Build 22000未満: high-risk approval、`remove`、`trust forget`はunavailableへfail closed。
- Build 22000以降でもHello未設定（`NotConfiguredForUser`）、verifier device無し
  （`DeviceNotPresent`）、ポリシー禁止（`DisabledByPolicy`）は同じくunavailable。
  **製品上の帰結**: Windows 10、およびHelloを設定していないWindows 11アカウントでは、
  high-risk deploy・`remove`・`trust forget`がLinuxと同じhandoff-onlyになる。`deploy`はPro機能
  なので、この条件は購入前に分かる場所（README・製品サイト）に書く。CLIも
  `humanPlaneRequirement()` で同じ要件を提示する。
- 全buildで維持する範囲: scan、vaultのsave/check/list、既存のSecret input、targets、dry-run、
  Free/Pro entitlement判定。本人確認をPro gateへ移さない。

## 3.1 helperのenv allowlistは「省略」では作れない

2026-09-05の実機計測で分かったこと。Node（libuv）はWindowsで、`spawn`の`env`に無い
次の変数を**親プロセスから補って**子へ渡す。

`PATH` / `TEMP` / `USERPROFILE` / `HOMEDRIVE` / `HOMEPATH` / `SYSTEMDRIVE` /
`USERNAME` / `USERDOMAIN` / `LOGONSERVER`

したがって`{ SystemRoot, WINDIR }`だけを渡していた実装では、Agentの`PATH`と`TEMP`が
そのままhelperへ入っていた。SECURITY.mdの「Agent由来の`PATH`を継承しない」という記述は
Windowsでは成立していなかった。

対応として、コード解決に関わるものは省略せず**明示的に上書き**する。`PATH`は固定の
system directoryのみ、`TEMP`/`TMP`はこの呼び出し専用のscratch directory、
`USERPROFILE`/`HOMEDRIVE`/`HOMEPATH`はOSのprofile lookup（deploy側と同じ
`resolveTrustedHomeDirectory()`）から導出する。`Add-Type -TypeDefinition`はcscで
helperのP/Invoke定義をコンパイルし、その成果物をtemp directoryから読み戻すため、
temp directoryを誰が決めるかはhelper自身のコードを誰が置けるかと同じ問題になる。

`USERNAME` / `USERDOMAIN` / `LOGONSERVER`はlibuvが補うままにする。呼び出し元を
名乗る文字列でコードやファイルの解決に使われず、helperはどれも読まない。

## 4. 変えない境界

- Secret input script、password control、`CredWriteW`のvalue pathは変更しない。
- `HumanPlane`はSecret値やverification tokenを返さず、closed statusだけを返す。
- Verified後もproject realpath、destination config、provider auth metadata、argv/pre-step、CLI identityを
  実行直前に再検証する。
- Linuxはhandoff-onlyのまま変更しない。
- macOS Human Planeは今回変更しない。ただしD-Wと同種の攻撃（同一ユーザーのプロセスが
  Accessibility APIで製品のボタンを押す）はmacOSにも形式上存在する。macOSではAX操作が
  TCCのAccessibility権限で保護されるため通らない可能性が高いが、これは**仮説であって計測結果ではない**。
  Windowsだけ本人確認必須という非対称を残したまま出す場合は、実測して非対称を解消するか、
  理由をSECURITY.mdに明記する。
- `deploy`のFree/Pro境界とMCPのproduction/GitHub拒否は変更しない。

## 5. 保証すること／しないこと

保証する範囲:

- 製品のWinForms Yes/DeleteをUIA/MSAAで動かしただけでは`approved`にならない。
- `Verified`以外のdocumented result、unknown result、例外、古いbuildはexit 0へfallbackしない。
- verifier requestはplan windowのowner `HWND`に関連付ける。
- Secret本文はverifier message、argv、env、stdio、戻り値へ入らない。

保証しない範囲:

- Microsoft資料に根拠がないため「Secure Desktopを使う」とは保証しない。
- `Verified`は現在のWindows userの本人確認であり、表示planを理解したことの証明ではない。
- verifier credentialの窃取・強要、elevated/debugger権限、任意のprocess injection、OS compromise、
  UI spoofingやprompt fatigueまでは防御しない。
- **自分自身のコードとプロセスの完全性は前提として仮定する。** 本製品はnpm packageとして
  `node_modules` へ展開されるので、同一OSアカウントでそこへ書ける主体は、本人確認の結果を
  消費する側のコードを直接書き換えられる。これは防御対象に含めない。同じ主体は
  Windows Credential Managerの本文を `CredRead` で直接読めるため、承認経路だけを固めても
  境界は動かない（§7）。
- 同一user process全般をWindows security principalとして分離するものではない。今回の成立条件は、
  D-Wで実測した通常権限のUIA/MSAA accessibility actuationが人間のOS本人確認を代行できないことに置く。

## 6. 実機検証

`npm run test:human-verification:windows -- <mode>`は実deploy・実削除を行わないcanary planで次を確認する。

- `probe`: 本人確認を持たないダミーWinFormsのYes/Deleteを、同じMSAA driverで操作する。
  人はクリックしない。driverの正常終了と操作完了checkpointに加え、ダミー側のClick発火も必須。
  Secret・vault・provider・製品承認は使わず、driverが実際に操作できたかだけを測る。
- `verified`: approvalとremovalで人間がWindows本人確認を完了し、両方がapprovedになる。
- `cancel`: 両方でOS promptをCancelし、declinedになる。
- `unconfigured`: Windows本人確認未設定accountで、MSAAが製品buttonを押してもunavailableになる。
- `attack`: D-W同等の別PowerShellがMSAA `accDoDefaultAction`だけでYes/Deleteを押す。OS promptを
  人間が認証せずCancelし、driverの操作完了と製品の`declined`の両方を必要とする。
  `approved`・`unavailable`・driver crash・timeout・操作証跡なしは成功にしない。

`attack`と`unconfigured`は毎回`probe`を先に実行し、不成立なら製品側の検証を開始しない。
mode単独の`probe`が最初のWindows確認手順である。同名の別画面を誤操作しないよう、
window captionに加えて今回起動したhelperのPIDを`GetWindowThreadProcessId`で照合する。
ダミー画面の成功はdriverの動作確認であり、旧製品の脆弱性再現や現行製品の修復証明そのものではない。

MSAAの呼び出しがclick handlerとOS本人確認の完了まで同期的に待つ場合を扱い、driver終了後の
固定1.5秒waitで「まだdecisionが終わっていないこと」を要求する旧判定は廃止した。
素早いキャンセルも、操作完了後のキャンセルも`declined`なら評価できる。子プロセスは起動直後から
追跡し、timeoutや失敗時には残ったdriver/control/helperを終了させる。

driver診断は固定の段階名と終了コードだけで、raw stderr・window本文・値は返さない。
`root-request`、`root-received`、`children-request`、`action-start`、`action-returned`等により、
次回の実機runでCFG crashが発生する呼び出しを絞る。CFGなどのOS保護は無効化しない。
この変更だけで既知の`0xC0000409`が解消したとは扱わない。

2026-09-08のWindows実測では、2回目の`children-request`で同じクラッシュを再現した。
`AccessibleChildren`の第1引数を`object`から`IAccessible`へ変更すると、同じ環境でダミーの
Yes/Delete両方が操作完了・Click発火・exit 0を満たした。native ABIは`IAccessible*`を要求するが、
`[MarshalAs(UnmanagedType.Interface)] object`は既定の`IDispatch`等を渡し得る
（[.NET object marshalling](https://learn.microsoft.com/en-us/dotnet/standard/native-interop/default-marshalling-for-objects)）。
これはdriverの局所修正であり、製品承認・Hello結果や他のOS buildまでの成功を意味しない。
過去の「marshaling signatureを除外した」という調査記録は、この型付き引数の実測結果を含まない。

実装照合に用いたMicrosoft資料:
[AccessibleObjectFromWindow](https://learn.microsoft.com/en-us/windows/win32/api/oleacc/nf-oleacc-accessibleobjectfromwindow)、
[AccessibleChildren](https://learn.microsoft.com/en-us/windows/win32/api/oleacc/nf-oleacc-accessiblechildren)、
[GetWindowThreadProcessId](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowthreadprocessid)。

Ubuntuでは`node tests/windows-verification-harness.mjs`で、probe失敗後に製品検証へ進まないこと、
キャンセルの順序差、crash/timeout/証跡欠落の拒否、早期approvedの検出、固定診断と子プロセス終了を
テストする。これはWindows API/PowerShell/Helloの実機結果ではなく、検証器の判定の確認である。

attack driverは`SendInput`、keyboard/mouse synthesis、`SendKeys`、`PostMessage`、target stdinを使わない。
実測日・OS build・各resultは推測で埋めず、実行後に`docs/VERIFICATION.md`へ記録する。

## 7. Elevated broker: v1では採用しない

### 7.1 PoCが示したこと

2026-09-05、製品package外の`poc/windows-elevated-broker/`をWindows
`10.0.26200.9168`で実測した。実Secret、Credential Manager、外部providerは使っていない。

- Decision Point 1は**条件付き成立**。同じsplit-token administratorがinteractive desktopを所有し、
  UACを承認する条件では、broker high/full、固定Explorer medium/limited、linked context
  medium/limitedをSID・session・`AuthenticationId`で結合し、broker所有HWNDから
  UserConsentVerifierの`Verified`を得た。別のadministrator credentialで昇格するstandard userは
  この結合に失敗するため、一般解ではない。
- Decision Point 2は**条件付き成立**。brokerをhigh/fullに保ったまま、結合済みExplorer tokenを
  primary medium/limitedへ複製し、固定fixtureだけをmediumで起動できた。snapshot再検証、
  write/deleteを拒否するlease、fresh allowlist env、匿名pipeだけの32-byte canary handoff、
  child image/token照合はすべて成立した。ただし`CreateProcessAsUserW`はerror 1314、
  explicit handle list付き`CreateProcessWithTokenW`はerror 87で、成立したのは通常
  `STARTUPINFO`の`CreateProcessWithTokenW`である。

機構としては動く。不採用の理由は実装可能性ではなく、境界としての費用対効果である。

### 7.2 不採用の理由

1. **金庫本文が同一ユーザーから読めたままなので、承認だけを固めても境界が動かない。**
   vaultは`@napi-rs/keyring`経由のWindows Credential Manager generic credentialで、
   同一OSアカウントの任意プロセスが`CredRead`で本文を取得できる。brokerがmediumで起動する
   provider CLI子プロセスも、同じアカウントから開ける。承認の扉だけを閉めても、隣の壁は開いている。
2. **broker側の承認結果を消費するコードが、いまはAgentの書ける場所にある。** npm package
   なので`node_modules`を1ファイル書き換えれば済む。これをbrokerで塞ぐには、vault自体を
   broker側へ移し、常駐サービス・保護されたinstall・署名・更新経路を持つ必要がある。
   それはv1の範囲ではなく別プロダクトの設計になる。
3. **MicrosoftはUACとintegrity levelを同一ユーザーに対するsecurity boundaryとして保証していない。**
   PoCを積み増しても「保証された境界」には到達しない領域である。
4. **DP1の限定条件は製品条件として悪い。** これを製品化すると、対応環境が「現在のdesktop所有者が
   自身をUAC昇格できるadministrator」に狭まり、標準ユーザーが落ちる。`UserConsentVerifier`は
   昇格を必要としないので、プロセス内方式のほうが対応範囲は広い。開発ツールのために
   常用アカウントを昇格させる運用も勧められない。

### 7.3 v1で引く線

> 自分のコードとプロセスの完全性は前提として仮定する。その外側から、文書化された
> 非特権APIで作用してくる経路は塞ぐ。自分のコード・プロセス・ファイルを改変してくる
> 攻撃は防がない。それはOSアカウントの陥落であり、その時点で金庫は既に読める。

この線で測ると、D-Wで実測したMSAA `accDoDefaultAction`（外側からの作用、非特権、文書化済み、
Agentが「Yesを押す」という自然な行動として到達しうる）は**塞ぐべき**であり、§2の方式で塞がる。
helper exit codeの偽装や`node_modules`の改変は**内側の改変**なので範囲外とし、SECURITY.mdに明記する。

### 7.4 PoCの扱い

`poc/windows-elevated-broker/`は研究記録として凍結する。未証明として残っている
保護されたinstall/ownership、実provider CLIと元user profile/authの実証、Agent-facing
bootstrap/IPC、並行実行時のhandle policyは、**v1のTODOではない**。将来チーム／企業向けに
別の信頼境界を持つ形態を検討する場合の入力として保持する。

commit `3f87fdb` の方式はv1で有効化する。このPoCを`packages/`から呼んではならない。

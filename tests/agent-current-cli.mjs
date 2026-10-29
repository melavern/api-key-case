// Current-entry guidance only: no real store/provider, native UI or app execution.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {AgentCurrentCliError,initializeAgentInstructions,renderAgentProtocol,resolveCurrentCliInvocation} from '../dist/core/agent/init.js';
import {ConnectionStateStore} from '../dist/core/agent/connection-state.js';
import {connectionCredentialRef,clerkCredentialRef} from '../dist/core/agent/connection-credential.js';
import {toAccount} from '../dist/core/vault/naming.js';

function literalArgv(text){const line=text.split('\n').find(l=>l.startsWith('- Literal invocation argv: '));assert.ok(line);return JSON.parse(line.slice(line.indexOf('['),line.lastIndexOf(']')+1));}
function firstCommand(text){const line=text.split('\n').find(l=>l.startsWith('- For API key,'));const m=/first inspect with (`+)(.*?)\1\./.exec(line);assert.ok(m);return m[2];}
function assertSelectionGuidance(text){
 const selection=text.split('\n').find(line=>line.startsWith('- connection.status is'));
 const acquisition=text.split('\n').find(line=>line.startsWith('- guidedSetup is'));
 assert.match(selection,/inspect the user's request and existing non-secret app configuration, then propose a supported app\/environment\/destination and route in plain language/);
 assert.match(selection,/Reuse explicit choices from the request or saved selection without asking again/);
 assert.match(selection,/Confirm only unresolved decisions together; do not make the human choose CLI terms/);
 assert.match(selection,/Never turn an inferred route into a confirmed choice, change a confirmed selection, invent a route or bypass permission\/operation approval/);
 assert.match(selection,/official-native integration meets the request, use it without duplicate vault registration/);
 assert.match(selection,/After the confirmed choice, record only the advisory intent with/);
 assert.match(selection,/This never configures or verifies a provider and grants no permission/);
 assert.match(acquisition,/grouped unresolved-decision confirmation above; do not acquire or save until the target\/environment\/route are confirmed/);
 assert.match(acquisition,/Reuse a confirmed selection without asking again/);
 assert.doesNotMatch(text,/ask the human to choose the exact route|Before selection, ask for the exact target/);
 assert.match(text,/Only after the human authorizes the named app and its concrete effects/);
 assert.match(text,/Execution requires Pro and fresh native OS approval/);
 const inventory=text.split('\n').find(line=>line.startsWith('- Private connection inventory:'));
 assert.match(inventory,/connection inventory --json <project>/);
 assert.match(inventory,/only the eleven known project slots/);
 assert.match(inventory,/do not ask for the same key again/);
 assert.match(inventory,/Pending, unavailable or changed records mean review-metadata, never missing/);
 assert.match(inventory,/does not select an old environment, enumerate other projects or user-scope secrets/);
 assert.match(inventory,/Old completed placements are historical only/);
 const resume=text.split('\n').find(line=>line.startsWith('- Private connection selection resumption:'));
 assert.match(resume,/when the user explicitly names a previously used environment/);
 assert.match(resume,/connection resume plan --service <resend\|clerk\|openai\|stripe-test> --env <environment>/);
 assert.match(resume,/For Resend plan only, omit --route when the route was not supplied/);
 assert.match(resume,/For Clerk, both plan and apply require an explicit route/);
 assert.match(resume,/Every apply requires the exact displayed route/);
 assert.match(resume,/exact reviewed report.route and `--fingerprint <plan-fingerprint>`/);
 assert.match(resume,/Missing history means not-recorded, never missing credentials/);
 assert.match(resume,/If an apply outcome is uncertain, preserve state and re-read\/re-plan; do not roll back/);
 assert.match(resume,/no local \.vercel\/Wrangler selector or account, credential, permission, approval, observation or current health is restored/);
 assert.match(resume,/public 0\.9\.2 is not a fallback/);
 const target=text.split('\n').find(line=>line.startsWith('- Private local target preparation:'));
 assert.match(target,/connection target plan --service <service> --env <environment>/);
 assert.match(target,/All IDs must already be explicitly known; never guess/);
 assert.match(target,/same inputs and `--fingerprint <plan-fingerprint>`/);
 assert.match(target,/does not create or authenticate a remote resource/);
 assert.match(target,/plan token is not approval and is never persisted as approval/);
 assert.match(target,/Generic connection plan remains unresolved/);
 assert.match(target,/adds a missing development\/preview entry to an existing strict selector-only wrangler\.jsonc/);
 assert.match(target,/every retained selector and the exact proposed addition/);
 assert.match(target,/no root\/other environment value is changed/);
 assert.match(target,/Windows\/macOS additive replacement and unsupported permission layouts stop/);
 assert.match(target,/After creation or an updated result/);
 const options=text.split('\n').find(line=>line.startsWith('- Private official route preselection:'));
 assert.match(options,/before asking the human to obtain a Resend\/Clerk key/);
 assert.match(options,/connection native options --service <resend\|clerk> --env <environment> --json/);
 assert.match(options,/not an inspected account, approved route, credential, eligibility or permission/);
 assert.match(options,/Do not select\/change a connection, execute provider commands, open a browser, log in, create keys, modify project files or deploy from a candidate report/);
 assert.match(options,/If the route is already selected, continue with the existing `connection native guide` rather than suggesting duplicate registration/);
 assert.match(options,/do not make them run CLI commands/);
 assert.match(options,/Public npm 0\.9\.2 does not include this candidate/);
 const check=text.split('\n').find(line=>line.startsWith('- For check-resend-credential,'));
 assert.match(check,/connection check --service resend --env <environment> --json/);
 assert.match(check,/saved selected connection.report.environment exactly/);
 assert.match(check,/never guess an environment or default to development/);
 assert.match(check,/even after inventory rediscovery/);
 assert.match(check,/on environment-mismatch, stop and refresh next/);
 assert.match(check,/no available selection, stop rather than run an unbound check/);
 const cloudflare=text.split('\n').find(line=>line.startsWith('- Private Cloudflare connection guide:'));
 assert.match(cloudflare,/already selected Resend\/Clerk\/OpenAI\/Stripe test api-key-case-managed Cloudflare route/);
 assert.match(cloudflare,/connection cloudflare guide --service <service> --env <environment> --json <project>/);
 assert.match(cloudflare,/same private CLI/);
 assert.match(cloudflare,/reuse it without asking for the same choice or key again/);
 assert.match(cloudflare,/selection-confirmed means only matching saved intent and local Wrangler configuration/);
 assert.match(cloudflare,/not login, remote settings, credential presence\/validity or working application evidence/);
 assert.match(cloudflare,/no provider request, vault read, browser launch, state write or deployment/);
 assert.match(cloudflare,/a guide or historical result grants no permission/);

}

// Restricted test decoder, not a launcher or a PowerShell implementation.
// The quote set and doubled-quote decoding follow the official lexer, not
// the renderer's regex: PowerShell v7.5.4 CharTraits.cs:251-260 and
// tokenizer.cs:2135-2167. All other syntax is refused by this test oracle.
function decodePowerShellInvocation(command){
 const singleQuotes=new Set(["'",'\u2018','\u2019','\u201a','\u201b']);
 assert.ok(command.startsWith('& '));let i=2;const argv=[];
 while(i<command.length){
  while(command[i]===' ')i++;if(i===command.length)break;
  let value='';
  if(singleQuotes.has(command[i])){
   i++;let closed=false;
   while(i<command.length){const c=command[i++];if(singleQuotes.has(c)){if(singleQuotes.has(command[i])){value+=command[i++];continue;}closed=true;break;}value+=c;}
   assert.ok(closed,'unterminated PowerShell literal');
   assert.ok(i===command.length||command[i]===' ','syntax escaped the quoted path');
  }else{
   const start=i;while(i<command.length&&command[i]!==' ')i++;value=command.slice(start,i);
   assert.match(value,/^[A-Za-z0-9_.-]+$/,'only fixed unquoted command arguments are allowed');
  }
  argv.push(value);
 }
 return argv;
}

export async function runAgentCurrentCliTests(){
 const evidence=process.env.AKC_CURRENT_CLI_EVIDENCE_DIR;if(evidence)mkdirSync(evidence,{recursive:true});
 const root=realpathSync(mkdtempSync(join(evidence??tmpdir(),'akc-current-cli-')));let cases=0;
 try{
  const defaultProtocol=renderAgentProtocol('0.9.2');assertSelectionGuidance(defaultProtocol);
  assert.equal(createHash('sha256').update(defaultProtocol).digest('hex'),'b3d2603376c9572f745bc125fafd9e6ac22333a6916c5a3dbf6fe9500f5782b0','schema-13 guidance includes the closed Resend native enrollment selection');
  for (const text of ['connection destinations --json', '--destination <catalog-id>', 'history schema 4', 'No arbitrary config path, command or --force',
    '--native-enrollment <resend-vercel-integration|resend-vercel-marketplace>', 'Existing Resend schema-1 choices are `unrecorded`']) assert.ok(defaultProtocol.includes(text));cases++;
  for(const version of ['0.10.0-rc.1','0.10.0','1.0.0']){
   const protocol=renderAgentProtocol(version),first=protocol.split('\n').find(line=>line.startsWith('- For API key,'));
   assert.ok(first.includes(`api-key-case@${version} secret capabilities --json`));
   assert.ok(first.includes(`api-key-case@${version} secret discover --project . --json`));
   assert.ok(!first.includes(' next '));assert.ok(!protocol.includes('@latest'));
   assert.match(protocol,/selection-required is not missing/);assert.match(protocol,/fresh native OS approval/);
   assert.match(protocol,/unknown provider\/app effects must not be automatically replayed/);
   assert.match(protocol,/never fall back to a legacy command/);cases++;
  }
  const checkout=join(root,process.platform==='win32'?"日本 語 CLI ' $() `literal`":"日本 語 CLI ' $(echo injected) `echo injected` \"literal\""),home=join(root,'fixture-home'),project=join(root,'fresh-project');
  for(const p of [checkout,home,project])mkdirSync(p);
  writeFileSync(join(checkout,'package.json'),JSON.stringify({name:'api-key-case',version:'0.9.2',type:'module',bin:{'api-key-case':'dist/cli/index.js'}}));
  cpSync(fileURLToPath(new URL('../dist',import.meta.url)),join(checkout,'dist'),{recursive:true});
  const modules=join(checkout,'node_modules'),sourceModules=realpathSync(fileURLToPath(new URL('../node_modules',import.meta.url)));mkdirSync(modules);
  for(const n of readdirSync(sourceModules))if(n!=='@napi-rs'&&!n.startsWith('.'))symlinkSync(join(sourceModules,n),join(modules,n),process.platform==='win32'?'junction':'dir');
  const fake=join(modules,'@napi-rs/keyring');mkdirSync(fake,{recursive:true});
  const marker=join(root,'effects.json'),slots=join(root,'slots.json');writeFileSync(marker,JSON.stringify({writes:0,children:0,probes:0}));writeFileSync(slots,'[]');
  writeFileSync(join(fake,'package.json'),'{"name":"@napi-rs/keyring","main":"index.cjs"}');
  writeFileSync(join(fake,'index.cjs'),`const fs=require('node:fs');exports.Entry=class{constructor(service,account){this.account=account}getPassword(){return JSON.parse(fs.readFileSync(${JSON.stringify(slots)},'utf8')).includes(this.account)?'synthetic-current-cli-key':null}setPassword(){const x=JSON.parse(fs.readFileSync(${JSON.stringify(marker)},'utf8'));x.writes++;fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(x));throw Error('No writes')}deletePassword(){throw Error('No deletes')}};`);
  const preload=join(root,'deny-effects.mjs');writeFileSync(preload,`import cp from'node:child_process';import fs from'node:fs';import{syncBuiltinESMExports}from'node:module';import{KeyringVault}from ${JSON.stringify(pathToFileURL(join(checkout,'dist/core/vault/keyring.js')).href)};const mark=${JSON.stringify(marker)},count=n=>{const x=JSON.parse(fs.readFileSync(mark,'utf8'));x[n]++;fs.writeFileSync(mark,JSON.stringify(x));};KeyringVault.prototype.isAvailable=async()=>{count('probes');throw Error('No probe')};for(const n of['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[n]=()=>{count('children');throw Error('No provider or child')};syncBuiltinESMExports();`);
  const entry=join(checkout,'dist/cli/index.js'),context=resolveCurrentCliInvocation(pathToFileURL(entry).href);
  const env={...process.env,HOME:home,USERPROFILE:home,DO_NOT_TRACK:'1',NODE_OPTIONS:''};
  const run=(args,extra={})=>{const result=spawnSync(process.execPath,[entry,...args],{cwd:project,env:{...env,...extra},encoding:'utf8',timeout:15000});assert.equal(result.error,undefined);return result;};
  const projectFile=join(project,'AGENTS.md');writeFileSync(projectFile,'Owner instructions stay.\n');
  const check=run(['agent-init','--use-current-cli','--host','agents','--check']);assert.equal(check.status,2);assert.equal(readFileSync(projectFile,'utf8'),'Owner instructions stay.\n');cases++;
  const initialized=run(['agent-init','--use-current-cli','--host','agents']);assert.equal(initialized.status,0,initialized.stderr);
  let text=readFileSync(projectFile,'utf8');assertSelectionGuidance(text);assert.ok(text.startsWith('Owner instructions stay.\n'));assert.deepEqual(literalArgv(text),[realpathSync(process.execPath),realpathSync(entry),'next','--json','--offline','.']);
  assert.deepEqual(literalArgv(initialized.stdout),literalArgv(text));assert.ok(!text.includes('node <api-key-case>'));assert.ok(!text.includes('node <checkout>'));assert.ok(!text.includes('npx -y api-key-case@0.9.2'));assert.match(text,/package version 0\.9\.2, next schemaVersion 13/);assert.match(text,/private Node build helper is unavailable/);cases++;
  assert.equal(run(['agent-init','--use-current-cli','--host','agents','--check']).status,0);assert.equal(run(['agent-init','--use-current-cli','--host','agents']).status,0);assert.equal(readFileSync(projectFile,'utf8'),text);cases++;
  for(const host of ['claude','cursor']){const dir=join(root,host);mkdirSync(dir);const r=run(['agent-init',dir,'--use-current-cli','--host',host]);assert.equal(r.status,0,r.stderr);const f=join(dir,host==='claude'?'CLAUDE.md':'.cursor/rules/api-key-case.mdc'),generated=readFileSync(f,'utf8');assertSelectionGuidance(generated);assert.deepEqual(literalArgv(generated),literalArgv(text));cases++;}
  writeFileSync(projectFile,text.replace('next schemaVersion 13','owner-modified schema'));const drift=run(['agent-init','--use-current-cli','--host','agents']);assert.equal(drift.status,1);assert.equal(readFileSync(projectFile,'utf8'),text.replace('next schemaVersion 13','owner-modified schema'));writeFileSync(projectFile,text);cases++;
  const publicProject=join(root,'public-default');mkdirSync(publicProject);assert.equal(run(['agent-init',publicProject,'--host','agents']).status,0);assert.match(readFileSync(join(publicProject,'AGENTS.md'),'utf8'),/npx -y api-key-case@0\.9\.2 next --json/);assert.ok(!readFileSync(join(publicProject,'AGENTS.md'),'utf8').includes('Literal invocation argv'));cases++;
  writeFileSync(join(project,'package.json'),JSON.stringify({name:'untrusted-project-cli',version:'99.0.0',bin:{'api-key-case':'project-controlled.js'}}));assert.equal(run(['agent-init','--use-current-cli','--host','agents']).status,0);assert.equal(readFileSync(projectFile,'utf8'),text);cases++;
  const arbitrary=run(['agent-init','--use-current-cli','--cli-path','project-controlled.js']);assert.equal(arbitrary.status,1);assert.equal(readFileSync(projectFile,'utf8'),text);cases++;
  const windows=resolveCurrentCliInvocation(pathToFileURL(entry).href,{platform:'win32'}),windowsText=renderAgentProtocol('0.9.2',windows);assert.deepEqual(literalArgv(windowsText),literalArgv(text));assert.ok(firstCommand(windowsText).startsWith("& '"));assert.ok(firstCommand(windowsText).includes(context.argv[1].replaceAll("'","''")));cases++;
  assert.deepEqual(decodePowerShellInvocation("& 'O’’Neil' '‘’' 'x’’; Write-Output injected; #' next"),['O’Neil','’','x’; Write-Output injected; #','next']);assert.throws(()=>decodePowerShellInvocation("& 'node' 'x’; Write-Output injected; #' next"));cases++;
  for(const q of ['\u2018','\u2019','\u201a','\u201b']){
   // Every character is legal in a Windows filename. These files are only
   // resolved/rendered; the synthetic Node, helper and CLI are never executed.
   const dir=join(root,`PS 日本 O${q}Neil ' $() \` “quoted”„ x${q}; Write-Output injected; #`);mkdirSync(join(dir,'dist/cli'),{recursive:true});mkdirSync(join(dir,'tools'));mkdirSync(join(dir,'project'));
   const psNode=join(dir,`Node ‘’‚‛ ' $() \` x${q}; Write-Output injected; #.exe`),psEntry=join(dir,'dist/cli/index.js'),psHelper=join(dir,'tools/build-local-node.mjs');
   for(const file of [psNode,psEntry,psHelper])writeFileSync(file,'// quoting fixture, never executed');writeFileSync(join(dir,'package.json'),readFileSync(join(checkout,'package.json')));
   const psContext=resolveCurrentCliInvocation(pathToFileURL(psEntry).href,{platform:'win32',execPath:psNode}),protocol=renderAgentProtocol('0.9.2',psContext);
   assert.deepEqual(decodePowerShellInvocation(firstCommand(protocol)),[psNode,psEntry,'next','--json','--offline','.']);assert.deepEqual(literalArgv(protocol),[psNode,psEntry,'next','--json','--offline','.']);
   const helperLine=protocol.split('\n').find(line=>line.startsWith('- For an ordinary Node JS/TS app')),helperCommand=/(`+)(.*?)\1/.exec(helperLine)[2].split(' <project>')[0];
   assert.deepEqual(decodePowerShellInvocation(helperCommand),[psNode,psHelper]);
   const saveLine=protocol.split('\n').find(line=>line.startsWith('- For actor=human kind=register-secret')),savePrefix=/(`+)(.*?)\1/.exec(saveLine)[2];
   assert.deepEqual(decodePowerShellInvocation(savePrefix),[psNode,psEntry]);
   initializeAgentInstructions({projectDir:join(dir,'project'),packageVersion:'0.9.2',check:false,host:'agents',currentCli:psContext});assert.deepEqual(decodePowerShellInvocation(firstCommand(readFileSync(join(dir,'project/AGENTS.md'),'utf8'))),literalArgv(protocol));cases++;
  }
  assert.throws(()=>resolveCurrentCliInvocation(pathToFileURL(entry).href,{execPath:join(root,'missing-node')}),e=>e instanceof AgentCurrentCliError&&e.reason==='entry-unavailable');cases++;
  assert.throws(()=>resolveCurrentCliInvocation(pathToFileURL(entry).href,{platform:'aix'}),e=>e instanceof AgentCurrentCliError&&e.reason==='unsupported-platform');cases++;
  const moved=entry+'.moved';renameSync(entry,moved);assert.throws(()=>initializeAgentInstructions({projectDir:project,packageVersion:'0.9.2',check:false,host:'agents',currentCli:context}),e=>e instanceof AgentCurrentCliError&&e.reason==='entry-unavailable');assert.equal(readFileSync(projectFile,'utf8'),text);renameSync(moved,entry);cases++;
  const bad=join(root,'unsupported.js');writeFileSync(bad,'// synthetic');assert.throws(()=>resolveCurrentCliInvocation(pathToFileURL(bad).href),e=>e instanceof AgentCurrentCliError&&e.reason==='entry-unsupported');cases++;
  const cache=join(root,'_npx','temporary-cli');mkdirSync(cache,{recursive:true});cpSync(checkout,cache,{recursive:true});const cacheEntry=join(cache,'dist/cli/index.js');const rejected=spawnSync(process.execPath,[cacheEntry,'agent-init','--use-current-cli','--host','agents',project],{env,encoding:'utf8',timeout:15000});assert.equal(rejected.status,1);assert.match(rejected.stderr,/transient-entry/);assert.equal(readFileSync(projectFile,'utf8'),text);cases++;
  // Fixed private tooling is resolved from the same package, never app metadata.
  mkdirSync(join(checkout,'tools'));writeFileSync(join(checkout,'tools/build-local-node.mjs'),'// not executed');const withHelper=resolveCurrentCliInvocation(pathToFileURL(entry).href);assert.ok(renderAgentProtocol('0.9.2',withHelper).includes(join('tools','build-local-node.mjs')));assert.ok(!renderAgentProtocol('0.9.2',withHelper).includes('<api-key-case>'));cases++;
  const toolsMoved=join(checkout,'tools-moved');renameSync(join(checkout,'tools'),toolsMoved);symlinkSync(toolsMoved,join(checkout,'tools'),process.platform==='win32'?'junction':'dir');assert.equal(resolveCurrentCliInvocation(pathToFileURL(entry).href).buildHelper,null);rmSync(join(checkout,'tools'));renameSync(toolsMoved,join(checkout,'tools'));cases++;
  if(process.platform!=='win32'){const literalRoot=join(root,'literal node <checkout>/dist/cli/index.js/cli-root');mkdirSync(join(literalRoot,'dist/cli'),{recursive:true});writeFileSync(join(literalRoot,'package.json'),readFileSync(join(checkout,'package.json')));const literalEntry=join(literalRoot,'dist/cli/index.js');writeFileSync(literalEntry,'// never executed');const literalContext=resolveCurrentCliInvocation(pathToFileURL(literalEntry).href),protocol=renderAgentProtocol('0.9.2',literalContext);assert.deepEqual(literalArgv(protocol),[realpathSync(process.execPath),literalEntry,'next','--json','--offline','.']);assert.ok(firstCommand(protocol).includes(literalEntry));cases++;}
  assert.equal(run(['agent-init','--use-current-cli','--host','agents']).status,0);text=readFileSync(projectFile,'utf8');
  // Seed a synthetic closed history without running any app or using a key.
  writeFileSync(join(project,'app.js'),'process.env.RESEND_API_KEY;');const store=new ConnectionStateStore(project,home),ref=connectionCredentialRef(project,'development');
  assert.equal(store.saveIntent({service:'resend',environment:'development',route:'api-key-case-managed',destination:{kind:'local'},sendingDomain:null}).ok,true);
  const registration=store.beginCredentialMutation(ref);assert.equal(registration.ok,true);assert.equal(store.finishCredentialMutation(ref,registration.value,true),true);writeFileSync(slots,JSON.stringify([toAccount(ref)]));
  const attempt=store.beginLocalSession(store.credentialRevision(ref),1000);assert.equal(attempt.ok,true);assert.equal(store.finishLocalSession(attempt.value.attemptId,'exited',true,{execution:'possible',treeTermination:'confirmed'}),true);
  for(const [authority,outcome] of [['agent-observed','passed'],['human-reported','received']])assert.equal(store.recordLocalSessionObservation({service:'resend',environment:'development',attemptId:attempt.value.attemptId,executionBasisId:attempt.value.executionBasisId,credentialRevision:attempt.value.credentialRevision,authority,outcome}).ok,true);
  const preloadOption=`--import=${pathToFileURL(preload).href}`;
  const invocation=literalArgv(text);const restored=spawnSync(invocation[0],invocation.slice(1),{cwd:project,env:{...env,NODE_OPTIONS:preloadOption},encoding:'utf8',timeout:15000});assert.equal(restored.status,0,restored.stderr);const report=JSON.parse(restored.stdout);assert.equal(report.schemaVersion,13);assert.equal(report.inspection.mode,'offline');assert.equal(report.connection.report.environment,'development');assert.equal(report.localSession.receipt.attemptId,attempt.value.attemptId);assert.equal(report.localSession.observationHistory.entries[0].observations.length,2);assert.equal(report.localSession.applicationReadiness,'not-verified');assert.ok(!report.nextActions.some(a=>a.kind==='register-connection-credential'));assert.deepEqual(JSON.parse(readFileSync(marker,'utf8')),{writes:0,children:0,probes:0});cases++;
  if(process.platform!=='win32'){const quoted=spawnSync('/bin/sh',['-c',firstCommand(text)],{cwd:project,env:{...env,NODE_OPTIONS:`--import=${preload}`},encoding:'utf8',timeout:15000});assert.equal(quoted.status,0,quoted.stderr);assert.equal(JSON.parse(quoted.stdout).localSession.receipt.attemptId,attempt.value.attemptId);cases++;}
  // A missing captured entry fails without an npx/provider/store fallback.
  renameSync(entry,moved);const absent=spawnSync(invocation[0],invocation.slice(1),{cwd:project,env,encoding:'utf8',timeout:15000});assert.notEqual(absent.status,0);assert.deepEqual(JSON.parse(readFileSync(marker,'utf8')),{writes:0,children:0,probes:0});renameSync(moved,entry);cases++;
  assert.ok(!restored.stdout.includes('synthetic-current-cli-key'));
  // A fresh Agent reads the generated guidance and resumes the selected managed
  // Cloudflare route with the captured CLI, without key entry or provider work.
  for(const service of ['resend','clerk']) {
   const cloudProject=join(root,`fresh-cloudflare-${service}`);mkdirSync(cloudProject);
   writeFileSync(join(cloudProject,'wrangler.toml'),'[env.preview]\nname="fresh-worker"\naccount_id="0123456789abcdef0123456789abcdef"\n');
   const cloudStore=new ConnectionStateStore(cloudProject,home),input={service,environment:'preview',route:'api-key-case-managed',destination:{kind:'cloudflare'},sendingDomain:null};
   assert.equal((service==='clerk'?cloudStore.saveClerkManagedIntent(input):cloudStore.saveIntent(input)).ok,true);
   const cloudRef=service==='clerk'?clerkCredentialRef(cloudProject,'preview'):connectionCredentialRef(cloudProject,'preview');
   const revision=cloudStore.beginCredentialMutation(cloudRef);assert.equal(revision.ok,true);assert.equal(cloudStore.finishCredentialMutation(cloudRef,revision.value,true),true);
   writeFileSync(slots,JSON.stringify([...JSON.parse(readFileSync(slots,'utf8')),toAccount(cloudRef)]));
   const initialized=run(['agent-init',cloudProject,'--use-current-cli','--host','agents']);assert.equal(initialized.status,0,initialized.stderr);
   const generated=readFileSync(join(cloudProject,'AGENTS.md'),'utf8');assertSelectionGuidance(generated);
   const freshInvocation=literalArgv(generated);
   const invoke=args=>spawnSync(freshInvocation[0],[...freshInvocation.slice(1,2),...args],{cwd:cloudProject,env:{...env,NODE_OPTIONS:preloadOption},encoding:'utf8',timeout:15000});
   const next=invoke(freshInvocation.slice(2));assert.equal(next.status,0,next.stderr);const state=JSON.parse(next.stdout);
   const selected=service==='clerk'?state.clerkManaged:state.connection.report;
   assert.equal(selected.service,service);assert.equal(selected.environment,'preview');assert.equal(selected.route,'api-key-case-managed');
   assert.equal(service==='clerk'?selected.registration.presence:selected.credential.status,'registered');
   const savedBefore=JSON.stringify(service==='clerk'?cloudStore.readClerkManagedIntent():cloudStore.readIntent());
   const command=['connection','cloudflare','guide','--service',selected.service,'--env',selected.environment,'--json','.'];
   for(let repeat=0;repeat<2;repeat++) {
    const result=invoke(command);assert.equal(result.status,0,result.stderr);const guide=JSON.parse(result.stdout);
    assert.equal(guide.state,'selection-confirmed');assert.equal(guide.environment,'preview');assert.equal(guide.selection.worker,'fresh-worker');
    assert.equal(guide.remoteConfiguration,'not-inspected');assert.equal(guide.credentialPresence,'not-inspected');assert.equal(guide.application,'not-checked');assert.equal(guide.permission,'none');
    assert.ok(!result.stdout.includes('synthetic-current-cli-key'));
   }
   assert.equal(JSON.stringify(service==='clerk'?cloudStore.readClerkManagedIntent():cloudStore.readIntent()),savedBefore);
   assert.deepEqual(JSON.parse(readFileSync(marker,'utf8')),{writes:0,children:0,probes:0});cases++;
  }

  // Fresh Agent reads the same saved environment through the captured CLI;
  // a later selection change cannot silently validate a different slot.
  const checkPreload=join(root,'deny-check-effects.mjs');
  writeFileSync(checkPreload,readFileSync(preload,'utf8')+`\nimport {ConnectionStateStore} from ${JSON.stringify(pathToFileURL(join(checkout,'dist/core/agent/connection-state.js')).href)};for(const name of['hasSecret','setSecret','deleteSecret'])KeyringVault.prototype[name]=async()=>{count('probes');throw Error('No credential access')};ConnectionStateStore.prototype.beginObservation=()=>{count('writes');throw Error('No journal write')};globalThis.fetch=()=>{count('children');throw Error('No network')};`);
  const invokeCheck=args=>run(['connection','check','--service','resend',...args],{NODE_OPTIONS:`--import=${pathToFileURL(checkPreload).href}`});
  for(const args of [['--env'],['--env','--json'],['--env','staging'],['--env','development','--env','production'],['--env','development','--env','development'],['--env','development','--unexpected']]) {
   const r=invokeCheck(args);assert.equal(r.status,1);assert.match(r.stderr,/Usage:.*connection check.*--env/);assert.equal(r.stdout,'');cases++;
  }
  const inventoryResult=run(['connection','inventory','--json'],{NODE_OPTIONS:preloadOption});assert.equal(inventoryResult.status,0,inventoryResult.stderr);
  const inventory=JSON.parse(inventoryResult.stdout),rediscovered=inventory.slots.find(slot=>slot.service==='resend'&&slot.selection.status==='selected');
  assert.equal(rediscovered.environment,report.connection.report.environment);assert.equal(rediscovered.presence,'registered');assert.equal(rediscovered.nextStep,'resume-selected-connection');cases++;
  const journal=JSON.stringify(store.readObservations());
  assert.equal(store.saveIntent({service:'resend',environment:'production',route:'api-key-case-managed',destination:{kind:'local'},sendingDomain:null}).ok,true);
  const selected=JSON.stringify(store.readIntent());
  const stale=invokeCheck(['--env',rediscovered.environment,'--json']);assert.equal(stale.status,1);
  assert.deepEqual(JSON.parse(stale.stdout),{service:'resend',status:'unknown',resultCode:'unknown',recorded:false,environment:'development',reason:'environment-mismatch'});
  const human=invokeCheck(['--env','development']);assert.equal(human.status,1);assert.match(human.stdout,/Resend development check stopped:.*different environment/);assert.match(human.stdout,/no provider check was run/);
  assert.equal(JSON.stringify(store.readIntent()),selected);assert.equal(JSON.stringify(store.readObservations()),journal);
  assert.deepEqual(JSON.parse(readFileSync(marker,'utf8')),{writes:0,children:0,probes:0});cases++;
  // Omitted --env keeps the prior CLI shape; it does not invent a target.
  const legacy=invokeCheck(['--json']);assert.equal(legacy.status,1);assert.deepEqual(Object.keys(JSON.parse(legacy.stdout)).sort(),['recorded','resultCode','service','status']);cases++;
  for(const environment of ['development','preview','production']) {
   const dir=join(root,`check-${environment}`);mkdirSync(dir);const state=new ConnectionStateStore(dir,home);
   assert.equal(state.saveIntent({service:'resend',environment,route:'api-key-case-managed',destination:{kind:'local'},sendingDomain:null}).ok,true);
   const r=invokeCheck(['--env',environment,'--json',dir]);assert.equal(r.status,1);assert.deepEqual(JSON.parse(r.stdout),{service:'resend',status:'unknown',resultCode:'unknown',recorded:false,environment});cases++;
  }
  assert.deepEqual(JSON.parse(readFileSync(marker,'utf8')),{writes:0,children:0,probes:0});
  assert.ok(![stale.stdout,human.stdout,legacy.stdout].join('').includes('synthetic-current-cli-key'));

  if(evidence){writeFileSync(join(evidence,'fixture-root.txt'),root);writeFileSync(join(evidence,'generated-example.md'),text);writeFileSync(join(evidence,'offline.json'),restored.stdout);}
  console.log(`Current CLI guidance: ${cases} cases passed; literal current entry, public npx pin retained, offline selection/history restored with zero writes/children/probes; no app/native/provider acceptance.`);
 }finally{if(!evidence)rmSync(root,{recursive:true,force:true});}
}

if(process.argv[1]===fileURLToPath(import.meta.url))await runAgentCurrentCliTests();

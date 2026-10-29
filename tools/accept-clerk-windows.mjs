// Developer acceptance only. Fixed synthetic project/provider; never a product entrypoint.
import {spawnSync} from 'node:child_process';
import {openSync,closeSync,writeSync,fsyncSync,renameSync,unlinkSync,readdirSync,lstatSync,realpathSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir,release} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {candidateRevision} from './accept-environment-windows.mjs';

export const SYNTHETIC_CLERK_VALUE='test-clerk-acceptance-only';
export const SYNTHETIC_VERSION='12345678-1234-1234-1234-123456789abc';

/** Fixed six-screen sequence. The operator may be the Windows agent; OS auth stays with the owner. */
export async function acceptClerkMilestone({invoke,tell,confirmLayout,record}){
 const evidence={schemaVersion:1,kind:'windows-clerk-milestone',status:'in-progress',steps:[],layoutConfirmed:false,cleanup:'not-started'};
 const persist=()=>record(structuredClone(evidence));
 const step=(id,expected,kind='credential')=>{
  let raw,result;try{raw=invoke(id);result=JSON.parse(raw.stdout);}catch{result=null;}
  let valid=false;
  if(result&&typeof result==='object'&&!Array.isArray(result)&&kind==='credential')valid=Object.keys(result).sort().join(',')==='environment,service,status'&&
    result.environment=== (id==='check-preview'?'preview':id==='check-production'?'production':'development')&&
    result.service===(id==='check-resend'?'resend':'clerk')&&['missing','registered','saved','cancelled','removed','unavailable','metadata-unavailable','already-registered'].includes(result.status);
  else if(result&&typeof result==='object'&&!Array.isArray(result)&&kind==='preflight')valid=Object.keys(result).sort().join(',')==='kind,status'&&result.kind==='preflight'&&['ready','unavailable'].includes(result.status);
  else if(result&&typeof result==='object'&&!Array.isArray(result)&&kind==='prepare')valid=Object.keys(result).sort().join(',')==='activation,historySaved,service,status,versionId'&&result.service==='clerk'&&
    ['declined','prepared','unknown','changed','unavailable'].includes(result.status)&&result.activation==='not-performed-by-this-invocation'&&
    (result.status==='prepared'?result.versionId===SYNTHETIC_VERSION&&result.historySaved===true:result.versionId===null&&typeof result.historySaved==='boolean');
  const passed=valid&&!raw.error&&raw.status===0&&result.status===expected;
  evidence.steps.push({id,expected,actual:valid?result.status:'unavailable',passed});persist();
  if(!passed)throw Error('step-failed');
 };
 persist();
 try{
  step('preflight','ready','preflight');
  for(const id of ['check-clerk','check-resend','check-preview','check-production'])step(id,'missing');
  tell(`保存画面: Clerk / development / 今回のテスト先を確認し、${SYNTHETIC_CLERK_VALUE} を入力して保存します。Agentが操作できます。本物のキーは使いません。`);
  evidence.cleanup='unconfirmed';persist();step('save','saved');step('check-clerk','registered');step('check-resend','missing');step('check-preview','missing');
  tell('準備の承認画面: 対象と最新コード・Version URLの注意書きを確認し、今回はキャンセルします。');
  step('decline-prepare','declined','prepare');
  tell('準備の承認画面: 同じ対象と注意書きを確認して承認します。Windowsの本人確認だけは所有者が操作してください。通信先は偽のローカルCLIです。');
  step('approve-prepare','prepared','prepare');
  tell('上書き画面: 何も入力せずキャンセルします。');step('cancel-overwrite','cancelled');step('check-clerk','registered');
  tell('削除画面: 今回はキャンセルします。');step('cancel-remove','cancelled');step('check-clerk','registered');
  tell('最後の削除画面: 今回のClerkテスト値だけを削除します。Windowsの本人確認だけは所有者が操作してください。');step('remove','removed');
  for(const id of ['check-clerk','check-resend','check-preview','check-production'])step(id,'missing');
  evidence.cleanup='credential-absence-confirmed';evidence.layoutConfirmed=await confirmLayout();evidence.status=evidence.layoutConfirmed?'checks-passed':'layout-unconfirmed';
 }catch{evidence.status='failed';}
 persist();return evidence;
}

export function enableClerkAcceptanceCopy(source,token){
 const from=`${token} = false`,enabled=`${token} = true`;
 const disabledCount=source.split(from).length-1,enabledCount=source.split(enabled).length-1;
 if(disabledCount+enabledCount!==1)throw Error('candidate-gate-mismatch');
 return disabledCount===1?source.replace(from,enabled):source;
}

export function acceptanceChildSource({dist,project,home,bin,publicKey}){
 const module=name=>JSON.stringify(pathToFileURL(join(dist,name)).href);
 return `import {createPublicKey} from 'node:crypto';
async function main(){try{
 const {createVault}=await import(${module('core/vault/index.js')});
 const {createHumanPlane}=await import(${module('core/human/index.js')});
 const {runConnectionCredential}=await import(${module('core/agent/connection-credential.js')});
 const {runClerkConnectionPrepare}=await import(${module('core/deploy/engine.js')});
 const {ConnectionStateStore}=await import(${module('core/agent/connection-state.js')});
 const project=${JSON.stringify(project)},home=${JSON.stringify(home)},step=process.argv[2];
 if(step==='preflight'){
  const {CloudflareVersionsAdapter}=await import(${module('adapters/cloudflare-versions.js')});
  const {buildTrustedExecution}=await import(${module('core/deploy/snapshot.js')});
  const {deriveProjectId}=await import(${module('core/vault/naming.js')});
  const adapter=new CloudflareVersionsAdapter('development'),plan=adapter.planDeploy('CLERK_SECRET_KEY','development');
  const bound=buildTrustedExecution({name:'CLERK_SECRET_KEY',scope:'project',projectId:deriveProjectId(project),env:'development',force:false,adapterId:'cloudflare',cliCommand:'wrangler',providerIdentity:null},plan,{projectDir:project,pathOverride:${JSON.stringify(bin)}});
  const status=bound.ok?await adapter.checkCli({cwd:bound.execution.cwd,env:bound.execution.env,resolvedCli:bound.execution.resolvedCli,pathOverride:${JSON.stringify(bin)}}):null;
  console.log(JSON.stringify({kind:'preflight',status:status?.installed&&status.loggedIn?'ready':'unavailable'}));return;
 }
 const deps={vault:createVault(),humanPlane:createHumanPlane(),connectionBaseDir:home};
 const operations={'check-clerk':['check','development','clerk',false],'check-resend':['check','development','resend',false],'check-preview':['check','preview','clerk',false],'check-production':['check','production','clerk',false],save:['save','development','clerk',false],'cancel-overwrite':['save','development','clerk',true],'cancel-remove':['remove','development','clerk',false],remove:['remove','development','clerk',false]};
 let result;if(Object.hasOwn(operations,step)){const [op,environment,service,force]=operations[step];result=await runConnectionCredential(project,environment,op,deps,force,service);}
 else if(['decline-prepare','approve-prepare'].includes(step)){
  const saved=new ConnectionStateStore(project,home).saveClerkManagedIntent({service:'clerk',environment:'development',route:'api-key-case-managed',destination:{kind:'cloudflare'},sendingDomain:null});if(!saved.ok)throw Error('metadata');
  const r=await runClerkConnectionPrepare({...deps,pathOverride:${JSON.stringify(bin)},historyBaseDir:home,licenseOptions:{baseDir:home,publicKey:createPublicKey(${JSON.stringify(publicKey)})}},{service:'clerk',environment:'development',projectDir:project,dryRun:false});
  result={service:'clerk',status:r.status,versionId:r.versionId,activation:r.activation,historySaved:r.historySaved};
 }else throw Error('unsupported');
 console.log(JSON.stringify(result));
}catch{console.log(JSON.stringify({status:'unavailable'}));process.exitCode=1;}}
await main();
`;
}

export async function main(){
 if(process.platform!=='win32'||Number(release().split('.')[2])<22000||!process.stdin.isTTY){console.error('Windows 11の対話型PowerShellから実行してください。');return 1;}
 if(process.argv.length!==2){console.error('引数は受け取りません。対象と値は専用の合成テストに固定されています。');return 1;}
 const root=dirname(dirname(fileURLToPath(import.meta.url))),revision=acceptanceRevision(root);
 if(!revision){console.error('候補の版と変更状態を確認できません。既存の変更を消さず、指定の専用作業場所を使ってください。');return 1;}
 const scratch=realpathSync.native(mkdtempSync(join(tmpdir(),'api-key-case-clerk-acceptance-'))),project=join(scratch,'project'),home=join(scratch,'metadata'),bin=join(scratch,'bin'),fixture=join(scratch,'candidate');
 for(const path of [project,home,bin,fixture])mkdirSync(path);
 const reportPath=join(scratch,'acceptance-result.json'),events=join(scratch,'fake-provider.json');
 const originals=new Map();
 try{
  const build=spawnSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'-p',join(root,'tsconfig.json'),'--outDir',join(fixture,'dist')],{cwd:root,encoding:'utf8',windowsHide:true,shell:false,timeout:120000,maxBuffer:1024*1024});
  if(build.status!==0||acceptanceRevision(root)!==revision)throw Error('candidate-build-failed');
  symlinkSync(join(root,'node_modules'),join(fixture,'node_modules'),'junction');writeFileSync(join(fixture,'package.json'),'{"type":"module","private":true}');
  for(const [name,token]of [['connection-credential','CLERK_CREDENTIAL_NATIVE_ACCEPTED'],['clerk-managed','CLERK_PREPARATION_NATIVE_ACCEPTED']]){
   const sourcePath=join(root,'packages/core/agent',name+'.ts'),compiledPath=join(fixture,'dist/core/agent',name+'.js'),source=readFileSync(compiledPath,'utf8');originals.set(sourcePath,createHash('sha256').update(readFileSync(sourcePath)).digest('hex'));writeFileSync(compiledPath,enableClerkAcceptanceCopy(source,token));
  }
  const compiledHash=compiledCandidateHash(join(fixture,'dist'));
  writeFileSync(join(project,'wrangler.toml'),'[env.development]\nname="synthetic-clerk-acceptance"\naccount_id="00000000000000000000000000000000"\n');
  const provider=`const fs=require('fs'),a=process.argv.slice(2);if(a[0]==='--version'){console.log('4.131.2');process.exit(0);}if(JSON.stringify(a)===JSON.stringify(['whoami','--json'])){console.log(JSON.stringify({loggedIn:true,accounts:[{id:'00000000000000000000000000000000'}]}));process.exit(0);}if(JSON.stringify(a)!==JSON.stringify(['versions','secret','put','CLERK_SECRET_KEY','--env','development']))process.exit(31);let value='';process.stdin.on('data',c=>value+=c);process.stdin.on('end',()=>{if(value!==${JSON.stringify(SYNTHETIC_CLERK_VALUE)})process.exit(32);const previous=fs.existsSync(${JSON.stringify(events)})?JSON.parse(fs.readFileSync(${JSON.stringify(events)},'utf8')).calls:0;fs.writeFileSync(${JSON.stringify(events)},JSON.stringify({calls:previous+1,syntheticInputMatched:true}));console.log('✨ Success! Created version ${SYNTHETIC_VERSION} with secret CLERK_SECRET_KEY.');});`;
  writeFileSync(join(bin,'provider.cjs'),provider);writeFileSync(join(bin,'wrangler.cmd'),`@echo off\r\n"${process.execPath}" "${join(bin,'provider.cjs')}" %*\r\n`);
  const keys=generateKeyPairSync('ed25519'),payload=Buffer.from(JSON.stringify({v:1,plan:'pro',id:'synthetic-clerk-acceptance',issuedAt:'2026-10-03'})).toString('base64url'),signed=`AKC1.${payload}`;
  const {saveLicenseKey}=await import(pathToFileURL(join(fixture,'dist/core/license.js')).href);saveLicenseKey(`${signed}.${sign(null,Buffer.from(signed),keys.privateKey).toString('base64url')}`,home);
  const child=join(fixture,'acceptance-child.mjs');writeFileSync(child,acceptanceChildSource({dist:join(fixture,'dist'),project,home,bin,publicKey:keys.publicKey.export({type:'spki',format:'pem'}).toString()}));
  const env={DO_NOT_TRACK:'1'};for(const name of ['SystemRoot','WINDIR','PATH','PATHEXT','ComSpec','TEMP','TMP','APPDATA','LOCALAPPDATA','HOME','USERPROFILE'])if(process.env[name])env[name]=process.env[name];
  const rl=createInterface({input:process.stdin,output:process.stdout});let latest;
  console.log(`専用テスト先: ${project}\n6画面を確認します。Agentが合成入力・キャンセル・表示確認を行えます。所有者は必要なWindows本人確認だけ操作してください。\n本物のキー・実Worker・通信は使いません。倍率や設定を変更せず、本人確認画面は撮影・記録しないでください。`);
  try{
   const result=await acceptClerkMilestone({invoke:step=>spawnSync(process.execPath,[child,step],{cwd:root,env,encoding:'utf8',windowsHide:true,shell:false,timeout:600000,maxBuffer:1024*1024}),tell:message=>console.log(`\n${message}`),
    confirmLayout:async()=>/^(y|yes)$/i.test((await rl.question('操作担当者が全画面のサービス・環境・対象・最新コード/Version URLの注意を読めたら y、確認できなければ n: ')).trim()),
    record:data=>{latest={...data,candidate:revision,windowsBuild:release(),nodeVersion:process.version,providerMode:'fixed-local-fake',compiledCandidateHash:compiledHash,productionGatesChanged:null};writeAcceptanceRecord(reportPath,latest);}});
   const final=finalizeClerkAcceptance(latest,{
    validate:finalRecord=>{
      const gatesUnchanged=[...originals].every(([path,hash])=>createHash('sha256').update(readFileSync(path)).digest('hex')===hash);
      const unchanged=compiledCandidateHash(join(fixture,'dist'))===compiledHash&&acceptanceRevision(root)===revision&&gatesUnchanged;
      const event=existsFile(events)?JSON.parse(readFileSync(events,'utf8')):null;
      finalRecord.productionGatesChanged=!gatesUnchanged;
      return unchanged&&event?.calls===1&&event.syntheticInputMatched===true;
    },
    cleanup:()=>{rmSync(join(fixture,'node_modules'));rmSync(fixture,{recursive:true});rmSync(bin,{recursive:true});},
    record:data=>{latest=data;writeAcceptanceRecord(reportPath,data);}
   });
   latest=final;
   if(latest.cleanup==='not-started')console.log('保存は開始していません。合成実行条件を確認するため、この記録を返してください。制限やPATHは変更しません。');
   console.log(`\n結果: ${latest.status}\n状態だけの記録: ${reportPath}\nテスト値の不在: ${latest.cleanup}。不明なものや失敗時の作業場所はそのまま残してください。`);
   return latest.status==='passed'?0:1;
  }finally{rl.close();}
 }catch{console.error(`確認を完了できませんでした。作業場所は保持しました: ${scratch}`);return 1;}
}
export function acceptanceRevision(root,run=spawnSync){
 const revision=candidateRevision(root,run);if(!revision)return null;
 const options={cwd:root,encoding:'utf8',windowsHide:true,shell:false};
 const tracked=run('git',['ls-files','--error-unmatch','tools/accept-clerk-windows.mjs'],options);
 const unknown=run('git',['ls-files','--others','--','packages'],options);
 const clean=run('git',['diff','--quiet','HEAD','--','tools/accept-clerk-windows.mjs'],options);
 return tracked.status===0&&unknown.status===0&&typeof unknown.stdout==='string'&&unknown.stdout.trim()===''&&clean.status===0?revision:null;
}
export function finalizeClerkAcceptance(evidence,{validate,cleanup,record}){
 let result={...evidence,status:evidence.status==='checks-passed'?'pending-final-validation':evidence.status};
 record(structuredClone(result));
 try{if(result.status==='pending-final-validation'){if(!validate(result))throw Error('final-evidence-failed');cleanup();result.status='passed';record(structuredClone(result));}}
 catch{result.status='failed';try{record(structuredClone(result));}catch{/* prior pending record cannot claim pass */}}
 return result;
}
export function writeAcceptanceRecord(path,value){
 const temporary=path+'.tmp';let fd,owned=false;
 try{fd=openSync(temporary,'wx',0o600);owned=true;const data=Buffer.from(JSON.stringify(value,null,2));let offset=0;while(offset<data.length){const written=writeSync(fd,data,offset,data.length-offset);if(written<=0)throw Error('record-write-failed');offset+=written;}fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temporary,path);owned=false;}
 finally{if(fd!==undefined)try{closeSync(fd);}catch{}if(owned)try{unlinkSync(temporary);}catch{}}
}
export function compiledCandidateHash(root){
 const records=[];
 function walk(dir,prefix=''){for(const name of readdirSync(dir).sort()){const path=join(dir,name),relative=prefix+name,stat=lstatSync(path);if(stat.isSymbolicLink())throw Error('linked-candidate');if(stat.isDirectory())walk(path,relative+'/');else if(stat.isFile()){const bytes=readFileSync(path);records.push({path:relative,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}else throw Error('non-file-candidate');}}
 walk(root);return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}
function existsFile(path){try{return readFileSync(path).length>0;}catch{return false;}}
if(process.argv[1]===fileURLToPath(import.meta.url))process.exitCode=await main();

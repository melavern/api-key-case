import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { acceptEnvironmentSlots, candidateRevision } from "../tools/accept-environment-windows.mjs";

export async function runWindowsEnvironmentAcceptanceTests() {
  const sha="1".repeat(40), calls=[];
  assert.equal(candidateRevision("synthetic",(command,args,opts)=>{ calls.push(args);assert.equal(opts.shell,false);return args[0]==="rev-parse"?{status:0,stdout:sha+"\n"}:{status:0}; }),sha);
  assert.ok(calls[1].includes("HEAD"));assert.ok(calls[1].includes("package-lock.json"));assert.ok(calls[1].includes("packages"));
  for(const status of [1,2,null]) assert.equal(candidateRevision("synthetic",(_c,args)=>args[0]==="rev-parse"?{status:0,stdout:sha}:{status}),null);
  for(const stdout of [undefined,"not-a-sha","secret-error-canary",sha+" extra"]) assert.equal(candidateRevision("synthetic",()=>({status:0,stdout})),null);

  const simulate = async ({ failure, layout = true } = {}) => {
    const present=new Set(), calls=[], reports=[];let removals=0;
    const result=await acceptEnvironmentSlots({
      invoke:args=>{
        calls.push(args);assert.deepEqual(args.slice(0,2),["connection","credential"]);
        assert.equal(args.includes("test-dev-52"),false);assert.equal(args.includes("test-prod-52"),false);
        const action=args[2], env=args[args.indexOf("--env")+1];let status,code=0;
        if(failure===calls.length)return {status:1,stdout:"raw-secret-error-canary",error:new Error("raw-error-canary")};
        if(action==="check") {status=present.has(env)?"registered":"missing";code=status==="missing"?1:0;}
        if(action==="save") {if(args.includes("--force")){status="cancelled";code=4;}else{present.add(env);status="saved";}}
        if(action==="remove") {if(++removals===1){status="cancelled";code=4;}else{present.delete(env);status="removed";}}
        return {status:code,stdout:JSON.stringify({service:"resend",environment:env,status})};
      },tell:()=>{},confirmLayout:async()=>layout,record:r=>reports.push(r)
    });
    assert.ok(!JSON.stringify(reports).includes("canary"));return {result,calls,reports,present};
  };
  if(process.platform!=="win32") { const r=spawnSync(process.execPath,[fileURLToPath(new URL("../tools/accept-environment-windows.mjs",import.meta.url))],{encoding:"utf8"});assert.equal(r.status,1);assert.equal(r.stdout,""); }
  const ok=await simulate();assert.equal(ok.result.status,"passed");assert.equal(ok.present.size,0);
  assert.equal(ok.calls.filter(x=>x[2]!=="check").length,6);
  assert.ok(ok.result.steps.find(x=>x.id==="production-survived").passed);
  assert.equal(ok.result.steps.filter(x=>x.id.startsWith("final-")).length,3);
  for(let n=1;n<=ok.calls.length;n++){const r=await simulate({failure:n});assert.equal(r.result.status,"failed");assert.equal(r.calls.length,n,"failure stops; no blind retry or cleanup");}
  assert.equal((await simulate({layout:false})).result.status,"layout-unconfirmed");
  console.log("Windows acceptance helper fixed-flow, failure and status-only report tests passed");
}
await runWindowsEnvironmentAcceptanceTests();

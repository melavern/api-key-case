import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubAdapter } from '../dist/adapters/github.js';
import { GitHubEnvironmentAdapter } from '../dist/adapters/github-environment.js';
import { resolveConnectionGitHubRepository } from '../dist/core/deploy/snapshot.js';

export async function runGitHubEnvironmentTests() {
  const root = fs.realpathSync.native(mkdtempSync(join(tmpdir(), 'akc-github-environment-')));
  let checks = 0;
  try {
    mkdirSync(join(root, '.git'));
    const config = join(root, '.git', 'config');
    for (const remote of ['https://github.com/owner/repository.git', 'git@github.com:owner/repository.git', 'ssh://git@github.com/owner/repository.git']) {
      writeFileSync(config, `[remote "origin"]\nurl = ${remote}\n`);
      assert.equal(resolveConnectionGitHubRepository(root), 'owner/repository'); checks++;
    }
    for (const remote of ['https://github.com.evil.example/owner/repository', 'https://github.com/owner/repository/extra', 'https://github.com:8443/owner/repository', 'file:///owner/repository', 'https://github.com/owner/../repository', 'https://github.com/owner/repository?other=1']) {
      writeFileSync(config, `[remote "origin"]\nurl = ${remote}\n`);
      assert.equal(resolveConnectionGitHubRepository(root), null); checks++;
    }
    for (const extra of ['[include]\npath = other', '[remote "other"]\nurl = https://github.com/other/repo', '[remote "origin"]\npushurl = https://github.com/other/repo']) {
      writeFileSync(config, `[remote "origin"]\nurl = https://github.com/owner/repository.git\n${extra}\n`);
      assert.equal(resolveConnectionGitHubRepository(root), null); checks++;
    }
    writeFileSync(config, '[remote "origin"]\nurl = https://github.com/owner/repository.git\n');
    writeFileSync(join(root,'.git','config.worktree'), '');
    assert.equal(resolveConnectionGitHubRepository(root), null); checks++;
    rmSync(join(root,'.git','config.worktree'));
    const ordinary='[remote "origin"]\nurl = https://github.com/owner/repository.git\n';
    const originalRead=fs.readSync,originalOpen=fs.openSync;
    let reads=0,trigger=true;
    try {
      fs.readSync=function(...args){reads++;assert.ok(args[3]<=64*1024+1);if(trigger){trigger=false;writeFileSync(config,ordinary+'#'.repeat(70*1024));}return originalRead.apply(this,args);};syncBuiltinESMExports();
      assert.equal(resolveConnectionGitHubRepository(root),null);assert.ok(reads>0);checks++;
    } finally {fs.readSync=originalRead;syncBuiltinESMExports();writeFileSync(config,ordinary);}
    if(process.platform!=='win32') {
      const other=join(root,'synthetic-other');writeFileSync(other,ordinary);reads=0;trigger=true;
      try {
        fs.openSync=function(...args){if(trigger&&args[0]===config){trigger=false;rmSync(config);fs.symlinkSync(other,config);}return originalOpen.apply(this,args);};
        fs.readSync=function(...args){reads++;return originalRead.apply(this,args);};syncBuiltinESMExports();
        assert.equal(resolveConnectionGitHubRepository(root),null);assert.equal(trigger,false,'fault injection targets the canonical config');assert.equal(reads,0);checks++;
      } finally {fs.openSync=originalOpen;fs.readSync=originalRead;syncBuiltinESMExports();rmSync(config);writeFileSync(config,ordinary);}
    }
    for (const environment of ['development', 'preview', 'production']) {
      const adapter = new GitHubEnvironmentAdapter('owner/repository', environment);
      const plan = adapter.planDeploy('RESEND_API_KEY', environment, {force:false});
      assert.deepEqual(plan.argv, ['gh','secret','set','RESEND_API_KEY','--repo','github.com/owner/repository','--env',environment]);
      assert.equal(plan.valueVia, 'stdin'); assert.equal(plan.overwriteWarning, true); checks++;
    }
    assert.deepEqual(new GitHubAdapter().planDeploy('RESEND_API_KEY','development',{force:false}).argv, ['gh','secret','set','RESEND_API_KEY']); checks++;
    for (const repository of ['owner/repository/extra', '--repo', 'owner/../repository', 'other.example/owner/repo']) {
      assert.throws(() => new GitHubEnvironmentAdapter(repository, 'development')); checks++;
    }
    console.log(`GitHub environment tests: ${checks} checks passed`);
  } finally { rmSync(root, {recursive:true,force:true}); }
}
if (process.argv[1] && process.argv[1].endsWith('github-environment.mjs')) await runGitHubEnvironmentTests();

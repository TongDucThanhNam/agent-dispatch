import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import {desktopHandoff, nodeExecutable} from '../src/index.ts';
import { rmTree } from './helpers.ts';

test('Node loader assets pass their Node-only suite', () => {
  const suite = path.join(import.meta.dir, 'node', 'desktop-compat.node.mjs');
  const result = spawnSync(nodeExecutable(), ['--test', suite], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('desktop handoff preserves exact session and rejects active or foreign sessions',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'zcode-handoff-'));t.after(()=>rmTree(root));
 const dbPath=path.join(root,'session.sqlite');const db=new DatabaseSync(dbPath);
 db.exec('CREATE TABLE session(id TEXT,directory TEXT,parent_id TEXT)');
 db.prepare('INSERT INTO session VALUES(?,?,?)').run('sess_fixture',root,null);db.close();
 const config={project:root,dbPath,workerKind:'zcode'},state={workerExited:true,sessionId:'sess_fixture'};
 const result=desktopHandoff(config,state);assert.equal(result.sessionId,'sess_fixture');assert.equal(new URL(result.desktopUrl).searchParams.get('path'),root);
 assert.deepEqual(result.tui.args.slice(-2),['--resume','sess_fixture']);
 assert.throws(()=>desktopHandoff(config,{...state,workerExited:false}),/worker to exit/);
 assert.throws(()=>desktopHandoff({...config,project:path.join(root,'other')},state),/does not belong/);
 assert.throws(()=>desktopHandoff({...config,workerKind:'agy'},state),/ZCode only/);
});

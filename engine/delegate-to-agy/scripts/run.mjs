#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { launch, main } from '../../delegate-to-zcode/scripts/run.mjs';
import { clean } from '../../delegate-to-zcode/scripts/monitor-core.mjs';

// The shared runner owns locking, monitoring, callbacks and review/resume state.
// Its AGY adapter is loaded only for AGY runs; ordinary ZCode launches are unchanged.
const args=process.argv.slice(2);
try {
  if(args[0]==='launch') {
    if(args.length!==3 || args[1]!=='--config') throw new Error('Use launch --config FILE.');
    const raw=JSON.parse(fs.readFileSync(path.resolve(args[2]),'utf8').replace(/^\uFEFF/,''));
    if(raw.workerKind && raw.workerKind!=='agy') throw new Error('This launcher creates AGY runs only.');
    console.log(JSON.stringify(await launch({...raw,workerKind:'agy'})));
  } else {
    if(['resume','stop','review','judge','rollback'].includes(args[0])) {
      const at=args.indexOf('--run-dir');
      if(at<0 || !args[at+1]) throw new Error('Supply the AGY run directory.');
      const saved=JSON.parse(fs.readFileSync(path.join(path.resolve(args[at+1]),'config.json'),'utf8').replace(/^\uFEFF/,''));
      if(saved.workerKind!=='agy') throw new Error('This is not an AGY run. Use its original launcher.');
    }
    await main(args);
  }
} catch(error) { console.error(clean(error.message,600));process.exitCode=1; }

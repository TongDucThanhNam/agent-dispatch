import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { StringDecoder } from 'node:string_decoder';
import { spawnCaptured, writeFileAtomic } from '../../delegate-to-zcode/scripts/dispatcher.mjs';

export const isConversationId = value => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value ?? '');
const normalized = value => { const resolved = fs.realpathSync(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const statuses = { ACTIVE:'running', RUNNING:'running', PENDING:'pending', DONE:'completed', ERROR:'error', CANCELED:'cancelled', CANCELLED:'cancelled' };
const json = value => JSON.stringify(value);

// /model is answered by the CLI without an inference request or preference change.
export async function readAgySelection(exe) {
  const result = await spawnCaptured(exe, ['-p', '/model', '--output-format', 'json'], { timeoutMs: 30_000 });
  if (!result.ok) throw new Error('AGY model selection could not be read. Check agy -p /model or specify model explicitly.');
  let selection; try { selection = JSON.parse(result.stdout).command?.data; } catch {}
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(selection?.id ?? '')) throw new Error('AGY did not return a usable model ID. Specify model explicitly.');
  return { model: selection.id, effort: ['low','medium','high'].includes(selection.effort) ? selection.effort : null };
}

export function buildAgyArgs(config, prompt) {
  const args = ['--dangerously-skip-permissions', '--add-dir', config.project, '-p', prompt, '--output-format', 'stream-json', '--print-timeout', config.agyPrintTimeout, '--model', config.agyModel];
  if (config.agyEffort) args.push('--effort', config.agyEffort);
  if (config.agyAgent) args.push('--agent', config.agyAgent);
  if (config.mode === 'plan') args.push('--mode', 'plan');
  if (config.resumeSessionId) args.push('--conversation', config.resumeSessionId);
  return args;
}

// A per-run projection lets AGY use the existing read-only dashboard/content reader.
// It never writes to AGY's own conversation database or to the ZCode database.
export function createAgyProjection(config, { prompt, startedAt = Date.now(), now = Date.now, onSession = () => {} } = {}) {
  // The projection db lives in the run directory; correction rounds use one
  // per worker process (agy-events-r<N>.sqlite) so per-round usage stays separable.
  if (path.dirname(path.resolve(config.dbPath)) !== path.resolve(config.runDir)) throw new Error('AGY telemetry must be inside its run directory.');
  if (fs.existsSync(config.dbPath)) throw new Error('AGY telemetry already exists; inspect the run instead of duplicating it.');
  const db = new DatabaseSync(config.dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=500;
    CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE INDEX message_session ON message(session_id,time_created);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE INDEX part_session ON part(session_id,time_created);
    CREATE INDEX part_message ON part(message_id);
    CREATE TABLE todo(session_id TEXT,content TEXT,status TEXT,position INTEGER);
    CREATE TABLE model_usage(id TEXT PRIMARY KEY,logical_request_id TEXT,attempt_index INTEGER,status TEXT,provider_id TEXT,model_id TEXT,
      started_at INTEGER,completed_at INTEGER,input_tokens INTEGER,output_tokens INTEGER,cache_read_input_tokens INTEGER,retry_count INTEGER,
      error_code TEXT,error_message TEXT,session_id TEXT,assistant_message_id TEXT);`);
  const putMessage = db.prepare(`INSERT INTO message VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET time_updated=excluded.time_updated,data=excluded.data`);
  const putPart = db.prepare(`INSERT INTO part VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET time_updated=excluded.time_updated,data=excluded.data`);
  const putUsage = db.prepare(`INSERT INTO model_usage VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    status=excluded.status,completed_at=excluded.completed_at,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,
    cache_read_input_tokens=excluded.cache_read_input_tokens,error_code=excluded.error_code,error_message=excluded.error_message`);
  let sessionId = null, terminal = null, closed = false;
  const steps = new Map();
  const touch = at => db.prepare('UPDATE session SET time_updated=? WHERE id=?').run(at, sessionId);
  const modelData = extra => ({ role:'assistant', modelID:config.agyModel, providerID:'agy', ...extra });
  function initialize(record, at) {
    if (!isConversationId(record.conversation_id)) throw new Error('AGY returned an invalid conversation ID.');
    if (sessionId && sessionId !== record.conversation_id) throw new Error('AGY changed conversation during this run.');
    if (config.resumeSessionId && config.resumeSessionId !== record.conversation_id) throw new Error('AGY resumed a different conversation.');
    if (normalized(record.init?.cwd ?? '') !== normalized(config.project)) throw new Error('AGY reported a different working directory.');
    if (record.init?.permission_mode !== 'always-proceed') throw new Error('AGY did not activate the requested permission mode.');
    if (record.init?.model && record.init.model !== config.agyModel) throw new Error('AGY reported a different model selection.');
    if (sessionId) return;
    sessionId = record.conversation_id;
    db.prepare('INSERT INTO session VALUES(?,?,?,?,?)').run(sessionId, config.project, null, startedAt, at);
    putMessage.run('agy-input',sessionId,startedAt,at,json({role:'user'}));
    putPart.run('agy-input-text','agy-input',sessionId,startedAt,at,json({type:'text',text:prompt}));
    onSession(sessionId);
  }
  function updateStep(record, at) {
    const data = record.step_update;
    if (!sessionId || data?.conversation_id !== sessionId) throw new Error('AGY step does not belong to the initialized conversation.');
    if (!Number.isSafeInteger(data.step_index) || data.step_index < 0) throw new Error('AGY returned an invalid step index.');
    if (data.step_type === 'user_input') { touch(at); return; }
    const previous = steps.get(data.step_index), duration = finite(data.duration_seconds), status = statuses[data.state] ?? 'recorded';
    const start = previous?.start ?? Math.max(startedAt, status === 'completed' && duration != null ? at-duration*1000 : at);
    const step = { ...previous, ...data, start, status, text:(previous?.text ?? '') + (typeof data.text_delta === 'string' ? data.text_delta : '') };
    // Update payloads may omit earlier input/output. Retain only recorded fields.
    step.tool_info = { ...previous?.tool_info, ...data.tool_info };
    step.usage = data.usage ?? previous?.usage;
    steps.set(data.step_index,step);
    const ended = ['completed','error','cancelled'].includes(status) ? at : null, id = 'agy-step-' + data.step_index;
    if (data.step_type === 'agent_response') {
      putMessage.run(id,sessionId,start,at,json(modelData({time:{created:start,...(ended ? {completed:ended} : {})}})));
      putPart.run(id+'-text',id,sessionId,start,at,json({type:'text',text:step.text}));
      const u=step.usage;
      putUsage.run(id,id,0,status,'agy',config.agyModel,start,ended,finite(u?.input_tokens),finite(u?.output_tokens),finite(u?.cache_read_tokens),0,
        data.error?.code ?? null, typeof data.error === 'string' ? data.error : data.error?.message ?? null,sessionId,id);
    } else if (data.step_type === 'tool') {
      putMessage.run(id+'-message',sessionId,start,at,json({role:'tool',time:{created:start,...(ended ? {completed:ended} : {})}}));
      const info=step.tool_info;
      putPart.run(id,id+'-message',sessionId,start,at,json({type:'tool',tool:data.tool_name ?? info.name ?? 'Tool',
        state:{status,input:info.parameters,output:info.output,error:info.error,time:{start,...(ended ? {end:ended} : {})}}}));
    }
    touch(at);
  }
  return {
    get sessionId() { return sessionId; },
    get terminal() { return terminal; },
    ingest(record) {
      if (closed) throw new Error('AGY projection is closed.');
      if (!record || typeof record !== 'object' || typeof record.event !== 'string') throw new Error('AGY emitted an invalid stream event.');
      if (terminal) throw new Error('AGY emitted data after its terminal result.');
      const at=now(); db.exec('BEGIN');
      try {
        if(record.event==='init') initialize(record,at);
        else if(record.event==='step_update') updateStep(record,at);
        else if(record.event==='result') {
          const value=record.result;
          if(!value || typeof value.status!=='string') throw new Error('AGY returned an invalid terminal result.');
          if(value.conversation_id && (!sessionId || value.conversation_id!==sessionId)) {
            // Startup failures can carry a session ID before init, but are never accepted.
            if(value.status==='SUCCESS' || sessionId) throw new Error('AGY result belongs to a different conversation.');
          }
          if(value.status==='SUCCESS' && !sessionId) throw new Error('AGY success has no verified conversation.');
          terminal={sessionId:sessionId ?? null,response:typeof value.response==='string'?value.response:'',agyStatus:value.status,
            cancelled:['CANCELED','INTERRUPTED'].includes(value.status),
            ...(value.status!=='SUCCESS'?{isError:true,error:value.error || {message:`AGY ended with status ${value.status}.`}}:{}),
            sessionUsage:value.usage ?? null,sessionTurns:value.num_turns ?? null};
          // Result usage is cumulative session usage. Never add it to this run's step totals.
          if(sessionId && value.status!=='SUCCESS') putMessage.run('agy-error',sessionId,at,at,json(modelData({error:terminal.error,time:{completed:at}})));
          if(sessionId) touch(at);
        }
        db.exec('COMMIT');
      } catch(error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { if(!closed) { closed=true;db.close(); } }
  };
}

export function startAgy(config, {prompt,startedAt,stderrFd,onSession,onFailure}, {spawnFn=spawn} = {}) {
  const projection=createAgyProjection(config,{prompt,startedAt,onSession});
  const log=fs.openSync(path.join(config.runDir,'agy-events.jsonl'),'wx');
  let child;
  try { child=spawnFn(config.agyExe,buildAgyArgs(config,prompt),{cwd:config.project,shell:false,windowsHide:true,
    detached:process.platform!=='win32',stdio:['ignore','pipe',stderrFd]}); }
  catch(error) {fs.closeSync(log);projection.close();throw error;}
  let buffer='',failure=null,finalized=false;
  const decoder=new StringDecoder('utf8');
  const fail=error=>{if(!failure){failure=error;onFailure?.(error);}};
  const processLine=line=>{
    if(!line.trim() || failure)return;
    try {projection.ingest(JSON.parse(line));}catch(error){fail(new Error('AGY event stream could not be read: '+error.message));}
  };
  child.stdout.on('data',chunk=>{
    try {
      fs.writeSync(log,chunk);buffer+=decoder.write(chunk);
      let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);processLine(line);}
      if(buffer.length>16_000_000){buffer='';fail(new Error('AGY emitted an oversized stream event.'));}
    }catch(error){fail(error);}
  });
  child.stdout.on('end',()=>{buffer+=decoder.end();if(buffer.trim())processLine(buffer);buffer='';});
  child.stdout.on('error',fail);
  return {child,finalize(){
    if(finalized)return;finalized=true;
    const result=failure?{sessionId:projection.sessionId,isError:true,error:{message:failure.message}}:
      projection.terminal ?? {sessionId:projection.sessionId,isError:true,error:{message:'AGY exited without a terminal result; completion is unconfirmed.'}};
    try{writeFileAtomic(path.join(config.runDir,'result.json'),json(result)+'\n');}finally{fs.closeSync(log);projection.close();}
  }};
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateConfig } from './run.mjs';

export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export const digest = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const alive = pid => {try {process.kill(pid, 0); return Number.isInteger(pid) && pid > 0;} catch (e) {return e.code === 'EPERM';}};
export function inside(root, file) {const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);}
export function projectPath(project, input) {
  if (typeof input !== 'string' || !input.trim() || path.isAbsolute(input)) throw new Error('Use project-relative paths.');
  const file = path.resolve(project, input);
  if (!inside(project, file)) throw new Error('Path escapes the project.');
  let probe = file;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  if (!inside(project, fs.realpathSync(probe))) throw new Error('Path escapes through a filesystem link.');
  return file;
}
const key = input => input.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
export const covers = (parent, child) => parent === '.' || key(parent) === key(child) || key(child).startsWith(key(parent) + '/');
export const overlaps = (a, b) => covers(a, b) || covers(b, a);
export const conflicts = (a, b) => a.exclusive || b.exclusive || a.writePaths.some(x => [...b.writePaths, ...b.readPaths, ...b.gateFiles].some(y => overlaps(x, y))) || b.writePaths.some(x => [...a.readPaths, ...a.gateFiles].some(y => overlaps(x, y)));
const text = (value, name, max, required = true) => {
  if (!required && value == null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be nonempty text under ${max} characters.`);
  return value;
};
const id = (value, name) => {if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) throw new Error(`Invalid ${name}.`); return value;};
const number = (value, fallback, name, max) => {const n = value ?? fallback; if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`Invalid ${name}.`); return n;};

export function validatePlan(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('A contract plan object is required.');
  const project = fs.realpathSync(path.resolve(raw.project ?? '.'));
  const paths = (value, name, required = false) => {
    if (value == null && !required) return [];
    if (!Array.isArray(value) || (required && !value.length) || value.length > 80) throw new Error(`${name} needs a bounded path array.`);
    return [...new Set(value.map(p => {
      const file = projectPath(project, p), rel = path.relative(project, file).replaceAll('\\', '/') || '.';
      if (rel.split('/').some(s => ['.git', '.zcode-dispatch', 'node_modules'].includes(s.toLowerCase()))) throw new Error(`${name} cannot include internal state, Git metadata or node_modules.`);
      return rel;
    }))];
  };
  const runId = id(raw.runId ?? `contract-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, 'runId');
  const base = validateConfig({...raw, schemaVersion: raw.schemaVersion === 3 ? undefined : raw.schemaVersion, project, runId, reviewMode: 'main-review', workflowVersion: 1, notify: raw.notify !== false});
  const objectiveId = id(raw.objectiveId ?? digest(project.toLowerCase() + '\n' + (base.threadId ?? 'local')).slice(0, 24), 'objectiveId');
  const objective = text(raw.objective, 'objective', 1500);
  const contextFiles = paths(raw.contextFiles, 'contextFiles');
  const auditPaths = paths(raw.auditPaths ?? raw.reviewPaths ?? ['.'], 'auditPaths', true);
  const protectedPaths = paths(raw.protectedPaths, 'protectedPaths');
  if (protectedPaths.some(p => !auditPaths.some(a => covers(a, p)))) throw new Error('auditPaths must cover protectedPaths.');
  const artifactPaths = paths(raw.artifactPaths, 'artifactPaths');
  const checkCommands = (items, name, required = true) => {
    if ((!Array.isArray(items) || !items.length) && required) throw new Error(`${name} needs at least one caller-assigned acceptance command; worker reports cannot authorize acceptance.`);
    const commands = items ?? [];
    validateConfig({...base, verificationCommands: commands});
    if (new Set(commands.map(c => c.name)).size !== commands.length) throw new Error('Acceptance check names must be unique.');
    if (commands.some(c => c.runOnBlocked !== undefined && typeof c.runOnBlocked !== 'boolean')) throw new Error('runOnBlocked must be a boolean assigned by the caller.');
    return commands.map(c => ({name: c.name, command: c.command, args: [...c.args], cwd: c.cwd ?? '.', timeoutMs: c.timeoutMs ?? 120000,
      ...(c.runOnBlocked === true ? {runOnBlocked: true} : {})}));
  };
  const rawTasks = raw.tasks ?? [{id: raw.stageId ?? 'implementation', promptFile: raw.promptFile, writePaths: raw.writePaths,
    readPaths: raw.readPaths, gateFiles: raw.gateFiles, acceptance: raw.acceptance ?? raw.stageAcceptance, checks: raw.checks ?? raw.verificationCommands, artifacts: raw.artifacts, maxAttempts: raw.maxAttempts, exclusive: true}];
  if (!Array.isArray(rawTasks) || !rawTasks.length || rawTasks.length > 40) throw new Error('Supply 1–40 coherent tasks.');
  const tasks = rawTasks.map(t => {
    const taskId = id(t.id, 'task id'), writePaths = paths(t.writePaths, 'writePaths', true);
    const readPaths = paths([...(t.readPaths ?? []), ...contextFiles], 'readPaths');
    const gateFiles = paths(t.gateFiles, 'gateFiles');
    if ([...writePaths, ...readPaths, ...gateFiles, ...protectedPaths].some(p => artifactPaths.some(a => overlaps(a, p)))) throw new Error(`${taskId}: disposable artifact paths must be separate from source, dependencies and pinned gates.`);
    if (writePaths.some(w => [...gateFiles, ...protectedPaths].some(g => overlaps(w, g)))) throw new Error(`${taskId}: write scope overlaps pinned gate/protected files; separate their ownership.`);
    if ([...writePaths, ...readPaths, ...gateFiles].some(p => !auditPaths.some(a => covers(a, p)))) throw new Error(`${taskId}: auditPaths must cover every declared source/read/gate scope.`);
    const checks = checkCommands(t.checks, `${taskId}.checks`);
    if (!Array.isArray(t.acceptance) || !t.acceptance.length || t.acceptance.length > 20) throw new Error(`${taskId}: supply acceptance criteria with check-name mappings.`);
    const acceptance = t.acceptance.map((a, index) => {
      if (typeof a === 'string') throw new Error('Acceptance criteria require {id, description, checks:[names]}; map every required outcome explicitly.');
      if (!Array.isArray(a.checks) || !a.checks.length || a.checks.some(n => !checks.some(c => c.name === n))) throw new Error(`${taskId}: acceptance criterion has missing or unknown checks.`);
      return {id: id(a.id ?? `criterion-${index + 1}`, 'criterion id'), description: text(a.description, 'criterion description', 1000), checks: [...new Set(a.checks)]};
    });
    if (new Set(acceptance.map(a => a.id)).size !== acceptance.length) throw new Error('Criterion IDs must be unique within a task.');
    const promptFile = path.resolve(t.promptFile ?? '');
    if (!t.promptFile || !fs.existsSync(promptFile)) throw new Error(`${taskId}: assignment file is missing.`);
    const assignment = text(fs.readFileSync(promptFile, 'utf8').replace(/^\uFEFF/, ''), 'assignment', 8000);
    const overrides = {...raw.worker, ...t.worker};
    const workerRaw = {...base, ...overrides, workerKind: overrides.workerKind ?? base.workerKind,
      // Worker config does not own project, notification or execution protocol.
      project, runId, runDir: base.runDir, promptFile, threadId: base.threadId, notify: false, reviewMode: 'main-review', workflowVersion: 1,
      callbackPolicy: 'actionable', keepOpenMs: 0};
    if (workerRaw.workerKind === 'zcode') {
      if (base.workerKind !== 'zcode') {
        workerRaw.expectedModel = overrides.expectedModel ?? 'GLM-5.3-Flash';
        workerRaw.expectedProvider = overrides.expectedProvider ?? 'builtin:zai-coding-plan';
        workerRaw.zcodeEffort = 'max';
      }
      const target = (overrides.model ?? overrides.expectedModel ?? workerRaw.expectedModel).split('/').at(-1);
      if (!Object.hasOwn(overrides, 'zcodeEffort')) {
        if (Object.hasOwn(overrides, 'effort')) workerRaw.zcodeEffort = overrides.effort;
        else if (target.toLowerCase() !== 'glm-5.3-flash') workerRaw.zcodeEffort = null;
      }
    } else {
      if (base.workerKind !== 'agy' && !overrides.model && !overrides.agyModel && !overrides.expectedModel) {workerRaw.expectedModel = 'pending-selection'; workerRaw.agyModel = null;}
      if (Object.hasOwn(overrides, 'effort') && !Object.hasOwn(overrides, 'agyEffort')) workerRaw.agyEffort = overrides.effort;
      if (Object.hasOwn(overrides, 'agent') && !Object.hasOwn(overrides, 'agyAgent')) workerRaw.agyAgent = overrides.agent;
    }
    const worker = validateConfig(workerRaw);
    const dependsOn = t.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some(n => typeof n !== 'string')) throw new Error('dependsOn must be an ID array.');
    const exclusive = t.exclusive === true || t.integration === true || writePaths.some(w => w === '.' || /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i.test(w));
    if (t.onBlocked !== undefined && !['strategy', 'human'].includes(t.onBlocked)) throw new Error('onBlocked must be strategy or human.');
    const task = {id: taskId, promptFile, assignment, dependsOn: [...new Set(dependsOn)], writePaths, readPaths, gateFiles, checks, acceptance,
      ...(t.onBlocked === 'human' ? {onBlocked: 'human'} : {}),
      ...(t.strategyNotes ? {strategyNotes: text(t.strategyNotes, 'strategyNotes', 3000)} : {}),
      artifacts: paths(t.artifacts, 'artifacts'), maxAttempts: number(t.maxAttempts, 3, 'maxAttempts', 20), exclusive, integration: t.integration === true, worker};
    return task;
  });
  if (new Set(tasks.map(t => t.id)).size !== tasks.length) throw new Error('Task IDs must be unique.');
  if (tasks.filter(t => t.integration).length > 1) throw new Error('Use one final integration task.');
  const integration = tasks.find(t => t.integration);
  if (integration) integration.dependsOn = [...new Set([...integration.dependsOn, ...tasks.filter(t => t !== integration).map(t => t.id)])];
  const visiting = new Set(), done = new Set();
  const visit = task => {
    if (visiting.has(task.id)) throw new Error('Task dependencies contain a cycle.');
    if (done.has(task.id)) return;
    visiting.add(task.id);
    for (const name of task.dependsOn) {const dep = tasks.find(t => t.id === name); if (!dep) throw new Error(`Unknown dependency: ${name}`); visit(dep);}
    visiting.delete(task.id); done.add(task.id);
  };
  tasks.forEach(visit);
  for (const t of tasks) t.contractHash = digest({id: t.id, assignment: t.assignment, acceptance: t.acceptance, checks: t.checks, writePaths: t.writePaths,
    ...(t.onBlocked === 'human' ? {onBlocked: 'human'} : {}),
    ...(t.strategyNotes ? {strategyNotes: t.strategyNotes} : {}),
    readPaths: t.readPaths, gateFiles: t.gateFiles, artifacts: t.artifacts, dependsOn: t.dependsOn, exclusive: t.exclusive});
  const finalChecks = checkCommands(raw.finalChecks, 'finalChecks', false);
  const finalGateFiles = paths(raw.finalGateFiles, 'finalGateFiles');
  if (finalGateFiles.some(p => artifactPaths.some(a => overlaps(a, p)))) throw new Error('Final gates cannot be disposable artifacts.');
  if (finalGateFiles.some(p => !auditPaths.some(a => covers(a, p)))) throw new Error('auditPaths must cover finalGateFiles.');
  const finalJudge = raw.finalJudge ?? 'human';
  if (!['human', 'astra'].includes(finalJudge)) throw new Error('finalJudge must be human or astra.');
  const judgmentCriteria = raw.judgmentCriteria ?? ['The assembled result satisfies the overall user goal.'];
  if (!Array.isArray(judgmentCriteria) || !judgmentCriteria.length || judgmentCriteria.length > 20) throw new Error('Supply bounded final judgment criteria.');
  judgmentCriteria.forEach(c => text(c, 'judgment criterion', 1000));
  for (const field of ['strategyChange', 'blockerResolved']) if (raw[field] != null) text(raw[field], field, 2000);
  if (tasks.length > 1 && finalChecks.length && !integration) throw new Error('Multiple tasks with application-wide final checks need an explicit integration task to own repairs.');
  const globalContractHash = digest({objective, contextFiles, protectedPaths, auditPaths, artifactPaths, finalChecks, finalGateFiles, finalJudge, judgmentCriteria});
  return {...base, schemaVersion: 3, workflowVersion: 3, reviewMode: 'contract', objectiveId, objective, tasks, contextFiles, protectedPaths, artifactPaths, auditPaths, finalChecks, finalGateFiles,
    globalContractHash, finalJudge, judgmentCriteria, maxParallel: number(raw.maxParallel, 2, 'maxParallel', 8),
    maxObjectiveCorrections: number(raw.maxObjectiveCorrections, 6, 'maxObjectiveCorrections', 100),
    maxWorkerContextTokens: number(raw.maxWorkerContextTokens, 240000, 'maxWorkerContextTokens', 2000000),
    storageRoot: raw.storageRoot ?? null, ledgerRoot: raw.ledgerRoot ?? null, docsDir: raw.docsDir ?? null, managedDashboard: raw.managedDashboard === true, managedCallbacks: raw.managedCallbacks === true,
    decisionPolicy: raw.decisionPolicy ?? null, decisionContext: raw.decisionContext ? text(raw.decisionContext, 'decisionContext', 8000) : '',
    notificationRoute: raw.notificationRoute ?? null,
    keepOpenMs: raw.keepOpenMs ?? 0, resumeFrom: raw.resumeFrom ? path.resolve(raw.resumeFrom) : null, strategyChange: raw.strategyChange ?? null, blockerResolved: raw.blockerResolved ?? null};
}

export function readyWave(plan, state) {
  const selected = [];
  const blocked = plan.tasks.filter(t => state.tasks[t.id].status === 'needs_replan' && state.tasks[t.id].blockedDecision);
  for (const task of plan.tasks) {
    if (state.tasks[task.id].status !== 'pending' || task.dependsOn.some(id => state.tasks[id].status !== 'accepted' && !(task.integration && state.tasks[id].status === 'regressed'))) continue;
    if (blocked.some(other => conflicts(task, other))) continue;
    if (selected.length < plan.maxParallel && !selected.some(other => conflicts(task, other))) selected.push(task);
  }
  return selected;
}

export function serializedPlan(plan) {
  return {...plan, tasks: plan.tasks.map(t => ({...t, worker: {...t.worker}}))};
}

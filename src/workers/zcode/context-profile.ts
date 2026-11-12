import fs from 'node:fs';

export const ZCODE_CONTEXT_PROFILES = ['files', 'web', 'shell', 'stock'] as const;
export type ZcodeContextProfile = typeof ZCODE_CONTEXT_PROFILES[number];

// Native 0.17.1 inventory. Never deny protocol-control tools such as
// RespondToCoordinator/submit_result/escalate. No executor or schema rewriting.
const auxiliaryTools = [
  'ToolSearch', 'DeferredToolCall', 'Glob', 'Grep', 'TodoRead', 'TodoWrite',
  'CronCreate', 'CronList', 'CronUpdate', 'CronDelete', 'CronPauseSelf',
  'OffPeakCreate', 'OffPeakList', 'EnterPlanMode', 'ExitPlanMode',
  'AskUserQuestion', 'SendMessage', 'ReadSessionContext', 'Agent', 'Task',
  'Skill', 'js', 'CreateWorkflow', 'AmendWorkflow', 'SaveWorkflow',
  'EvalWorkflowSnippet', 'ListWorkflowRuns', 'GetWorkflowRun', 'ResumeWorkflowRun',
  'ResolveWorkflowQuestion', 'FillWorkflowHole', 'ListSavedWorkflows', 'ListModels',
];
const requiredFlags = ['--disallowed-tools', '--toolsearch-mode', '--workflow-mode'];

export function zcodeContextArgs(profile: ZcodeContextProfile | null | undefined): string[] {
  if (profile == null || profile === 'stock') return [];
  if (!ZCODE_CONTEXT_PROFILES.includes(profile)) throw Error('Invalid ZCode context profile. Use files, web, shell or stock.');
  const denied = [...auxiliaryTools, ...(profile === 'web' ? [] : ['WebFetch', 'WebSearch']),
    ...(profile === 'shell' ? ['Read', 'Write', 'Edit'] : [])];
  return ['--disallowed-tools', denied.join(','), '--toolsearch-mode', 'off', '--workflow-mode', 'disabled'];
}

/** Read-only capability check; no CLI startup, login, settings writes or inference. */
export function verifyZcodeContextSupport(config: { nativeCli: string; zcodeContextProfile?: ZcodeContextProfile | null }) {
  if (!zcodeContextArgs(config.zcodeContextProfile).length) return;
  const source = fs.readFileSync(config.nativeCli, 'utf8');
  const missing = requiredFlags.filter(flag => !source.includes(flag));
  if (missing.length) throw Error(`ZCode CLI lacks context-profile flags: ${missing.join(', ')}. Use --context-profile stock or update the CLI; no ZCode settings were changed.`);
}

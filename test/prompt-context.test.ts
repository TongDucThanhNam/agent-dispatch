import { expect, test } from 'bun:test';
import path from 'node:path';
import { buildPrompt } from '../src/core/supervisor.ts';

const base = { runId: 'run-1', project: path.resolve('project'), workerKind: 'codex' };

test('every stage prompt carries the context budget between the stage preamble and the brief', () => {
  for (const stage of ['discovery', 'execution']) {
    const prompt = buildPrompt({ ...base, stage }, 'BRIEF');
    const at = prompt.indexOf('Context budget: ');
    expect(at).toBeGreaterThan(prompt.indexOf(stage === 'discovery' ? 'Discovery stage: ' : 'Execution ownership: '));
    expect(at).toBeLessThan(prompt.indexOf('BRIEF'));
    expect(prompt).toMatch(/Do not load images, screenshots or binary files into context unless the brief or project instructions require visual inspection/);
    expect(prompt).toMatch(/long command, test or build output to a file under \.tmp\/ and read only the failing or final part/);
  }
});

test('the context budget precedes the discovery packet in execution prompts', () => {
  const discoveryRunDir = path.resolve('project', '.agent-dispatch', 'disc');
  const prompt = buildPrompt({ ...base, stage: 'execution', discoveryRunDir }, 'BRIEF');
  expect(prompt.indexOf('Context budget: ')).toBeLessThan(prompt.indexOf('Discovery packet: '));
  expect(prompt.endsWith('BRIEF')).toBe(true);
});

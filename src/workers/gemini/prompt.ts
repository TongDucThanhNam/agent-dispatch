import fs from 'node:fs';
import { createRequire } from 'node:module';
import { asset } from '../../core/paths.ts';

const safety = createRequire(import.meta.url)(asset('node', 'gemini-safety.cjs'));
export const assertSafeGeminiPrompt: (prompt: string, addresses?: string[]) => void = safety.assertSafePrompt;
export const validateGeminiEmails: (addresses?: string[]) => string[] = safety.validateAllowEmails;

/** No implicit repository access; only the caller's explicitly named context file. */
export function consultationPrompt(config: any, question: string) {
  const context = config.geminiContextFile ? fs.readFileSync(config.geminiContextFile, 'utf8').replace(/^\uFEFF/, '') : null;
  if (context !== null && !context.trim()) throw Error('Gemini context file is empty.');
  const prompt = context === null ? question : `=== Context ===\n${context}\n\n=== Question ===\n${question}`;
  if (!prompt.trim() || prompt.length > 100_000) throw Error('Gemini consultation must contain 1–100,000 characters; nothing is truncated.');
  assertSafeGeminiPrompt(prompt, config.geminiAllowEmails);
  return prompt;
}

export interface ToolError { title: string; exitCode?: number; command?: string; detail?: string }

/** "Shell failed (exit 1): cmd" and "apply_patch verification failed: …" style messages, split for display. */
export function parseToolError(text: string): ToolError {
  const exit = /^(.{1,60}?) failed \(exit (-?\d+)\)(?::\s*([\s\S]*))?$/.exec(text.trim());
  if (exit) return { title: `${exit[1]} failed`, exitCode: Number(exit[2]), command: exit[3]?.trim() || undefined };
  const colon = /^([^:\n]{3,80}):\s+([\s\S]+)$/.exec(text.trim());
  if (colon && !/[\\/]$/.test(colon[1]) && !/^[A-Za-z]$/.test(colon[1])) return { title: colon[1], detail: colon[2] };
  const [first, ...rest] = text.trim().split('\n');
  return { title: first, detail: rest.join('\n').trim() || undefined };
}

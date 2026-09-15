export type ProcessResult = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  uncertain?: boolean;
};
export async function execute(
  argv: string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
    limit?: number;
    input?: string;
    env?: Record<string, string | undefined>;
    onStdoutLine?: (line: string) => boolean | void;
  } = {},
): Promise<ProcessResult> {
  const limit = options.limit ?? 1024 * 1024;
  let proc: Bun.Subprocess<any, "pipe", "pipe">;
  try {
    proc = Bun.spawn(argv, {
      cwd: options.cwd,
      env: options.env,
      stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
  } catch (error) {
    return { ok: false, exitCode: null, stdout: "", stderr: String(error) };
  }
  let timedOut = false;
  let stopped = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, options.timeoutMs ?? 30000);
  async function consume(stream: ReadableStream<Uint8Array>, observe = false) {
    let text = "";
    let pending = "";
    const decoder = new TextDecoder();
    for await (const part of stream) {
      const chunk = decoder.decode(part, { stream: true });
      if (text.length < limit) text += chunk.slice(0, limit - text.length);
      if (observe && options.onStdoutLine && !stopped) {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop()!;
        for (const line of lines)
          if (options.onStdoutLine(line) === false) {
            stopped = true;
            proc.kill();
            break;
          }
        if (pending.length > limit) {
          stopped = true;
          proc.kill();
        }
      }
    }
    return text;
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    consume(proc.stdout, true),
    consume(proc.stderr),
  ]);
  clearTimeout(timer);
  return {
    ok: exitCode === 0 && !timedOut && !stopped,
    exitCode,
    stdout,
    stderr,
    uncertain: timedOut,
  };
}

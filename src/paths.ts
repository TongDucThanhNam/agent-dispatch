import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createHash } from "node:crypto";
export const home = path.resolve(
  process.env.AGENT_DISPATCH_HOME || path.join(os.homedir(), ".agent-dispatch"),
);
export const projectRoot = path.resolve(import.meta.dir, "..");
export const engine = path.join(
  projectRoot,
  "engine/delegate-to-zcode/scripts",
);
export const node =
  process.env.AGENT_DISPATCH_NODE ||
  Bun.which("node.exe") ||
  Bun.which("node") ||
  "node";
export const zcode =
  process.env.AGENT_DISPATCH_ZCODE ||
  path.join(os.homedir(), "AppData/Local/Programs/ZCodeCLI/zc.mjs");
export const codex =
  process.env.AGENT_DISPATCH_CODEX ||
  path.join(os.homedir(), "AppData/Local/Programs/OpenAI/Codex/bin/codex.exe");
export const keyFor = (s: string) =>
  createHash("sha256")
    .update(
      process.platform === "win32"
        ? path.resolve(s).toLowerCase()
        : path.resolve(s),
    )
    .digest("hex")
    .slice(0, 24);
export const read = (file: string): any =>
  JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
export function save(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
export function alive(pid: number) {
  try {
    if (!Number.isInteger(pid) || pid < 1) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
export function within(root: string, file: string) {
  const rel = path.relative(root, file);
  return (
    rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel)
  );
}

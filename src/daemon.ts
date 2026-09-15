import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { home, read, projectRoot } from "./paths";
export async function ensureServer(root = home) {
  const file = path.join(root, "daemon.json");
  async function health() {
    try {
      const r = read(file);
      const u = new URL(r.url);
      if (u.hostname !== "127.0.0.1" || u.protocol !== "http:") return null;
      const response = await fetch(r.url + "api/health", {
        signal: AbortSignal.timeout(1000),
      });
      const j = (await response.json()) as any;
      return j.name === "agent-dispatch" && j.instance === r.instance
        ? r
        : null;
    } catch {
      return null;
    }
  }
  let current = await health();
  if (current) return current;
  fs.mkdirSync(root, { recursive: true });
  const out = fs.openSync(path.join(root, "server.log"), "a"),
    err = fs.openSync(path.join(root, "server-stderr.log"), "a");
  // Bun.spawn has no portable detached daemon contract on this Windows runtime.
  // node:child_process is used only for detachment; the service itself runs Bun.
  const child = spawn(
    process.execPath,
    [path.join(projectRoot, "src/server.ts")],
    {
      env: { ...process.env, AGENT_DISPATCH_HOME: root },
      cwd: projectRoot,
      stdio: ["ignore", out, err],
      windowsHide: true,
      detached: true,
    },
  );
  fs.closeSync(out);
  fs.closeSync(err);
  let error: any;
  child.once("error", (e) => (error = e));
  child.unref();
  for (let i = 0; i < 60; i++) {
    if (error) throw error;
    await Bun.sleep(100);
    current = await health();
    if (current) return current;
  }
  throw Error(
    `Dashboard did not become healthy. Inspect ${path.join(root, "server-stderr.log")}. The configured port is retained; links are never silently moved.`,
  );
}

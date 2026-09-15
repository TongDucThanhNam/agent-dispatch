import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store";
import { save, projectRoot } from "../src/paths";

test("CLI project listing limits all collections and command help works without starting a daemon", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-cli-"));
  const store = new Store(root);
  const cli = (...args: string[]) => Bun.spawnSync([process.execPath, path.join(projectRoot, "src/cli.ts"), ...args], {
    env: {...process.env, AGENT_DISPATCH_HOME: root}, stdout: "pipe", stderr: "pipe",
  });
  try {
    const project = path.join(root, "wanted");
    for (const name of ["one", "two", "foreign"]) {
      const directory = path.join(root, "runs", name);
      save(path.join(directory, "config.json"), {runId: name, runDir: directory, project: name === "foreign" ? path.join(root, "other") : project});
      save(path.join(directory, "status.json"), {runId: name, status: "complete", workerExited: true, loopActive: false, tasks: {}});
      const id = store.register(directory);
      store.localNotice(`run:${id}:terminal`, "thread", "terminal", "done");
    }
    const listed = cli("list", "--project", project, "--limit", "1");
    expect(listed.exitCode).toBe(0);
    const data = JSON.parse(listed.stdout.toString());
    expect(data.totalRuns).toBe(2); expect(data.runs.length).toBe(1);
    expect(data.runs[0].project).toBe(project);
    expect(data.totalNotifications).toBe(2); expect(data.notifications.length).toBe(1);
    expect(cli("list", "--limit", "0").exitCode).toBe(1);
    const help = cli("run", "--help");
    expect(help.exitCode).toBe(0); expect(help.stdout.toString()).toContain("--plan FILE");
    expect(fs.existsSync(path.join(root, "daemon.json"))).toBe(false);
  } finally {
    store.close();
    const resolved = fs.realpathSync(root);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith("dispatch-cli-")) throw Error("Unsafe cleanup");
    fs.rmSync(resolved, {recursive: true, force: true});
  }
});

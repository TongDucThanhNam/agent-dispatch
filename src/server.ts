import fs from "node:fs";
import path from "node:path";
import { prepareJson } from "./http-cache";
import { home, read, save, projectRoot, within } from "./paths";
import { Store } from "./store";
import { snapshot, importLegacy, runDetail } from "./catalog";
import { tickWatches } from "./watches";
import { bridge } from "./workflow";
import { tickDecisions } from "./decisions";
export async function serve(
  root = home,
  requestedPort?: number,
  options = { background: true, legacy: true },
) {
  fs.mkdirSync(root, { recursive: true });
  const configFile = path.join(root, "server.json");
  const config = fs.existsSync(configFile)
    ? read(configFile)
    : {
        port: 43171,
        token: crypto.randomUUID().replaceAll("-", ""),
        instance: crypto.randomUUID(),
      };
  if (requestedPort !== undefined) config.port = requestedPort;
  const store = new Store(root);
  let cached: any = {
      at: null,
      runs: [],
      watches: store.watches(),
      notifications: [],
    },
    catalogError: string | null = null;
  const prefix = `/${config.token}/`;
  let summaryResponse = prepareJson({ ...cached, catalogError });
  let busy = false;
  let refreshedAt = 0;
  let refreshPending: Promise<void> | null = null;
  const details = new Map<
    string,
    { at: number; pending: Promise<ReturnType<typeof prepareJson>> }
  >();
  const refresh = async () => {
    if (refreshPending) return refreshPending;
    if (refreshedAt && Date.now() - refreshedAt < 5000) return;
    refreshPending = (async () => {
      try {
        cached = await snapshot(store);
        catalogError = null;
      } catch (e) {
        catalogError = String(e);
      } finally {
        summaryResponse = prepareJson({ ...cached, catalogError });
        refreshedAt = Date.now();
      }
    })();
    try {
      await refreshPending;
    } finally {
      refreshPending = null;
    }
  };
  const assetRoot = path.join(projectRoot, "dist");
  const indexFile = Bun.file(path.join(assetRoot, "index.html"));
  if (!(await indexFile.exists()))
    throw Error("Dashboard build missing: run bun run build");
  const indexHtml = (await indexFile.text()).replace(
    "<head>",
    `<head><base href="${prefix}">`,
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: config.port,
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get("host") !== `127.0.0.1:${server.port}`)
        return new Response("Unknown host", { status: 403 });
      if (!url.pathname.startsWith(prefix))
        return new Response("Not found", { status: 404 });
      const route = url.pathname.slice(prefix.length);
      if (route === "api/health")
        return Response.json({
          name: "agent-dispatch",
          instance: config.instance,
          pid: process.pid,
        });
      if (route === "api/snapshot" && req.method === "GET") {
        await refresh();
        return summaryResponse.respond(req);
      }
      const detail = route.match(/^api\/runs\/([a-f0-9]{24})$/i);
      if (detail && req.method === "GET") {
        const id = detail[1];
        if (!store.run(id)) return new Response("Unknown run", { status: 404 });
        let entry = details.get(id);
        if (!entry || Date.now() - entry.at >= 5000) {
          entry = {
            at: Date.now(),
            pending: runDetail(store, id).then(prepareJson),
          };
          details.delete(id);
          details.set(id, entry);
          if (details.size > 32) details.delete(details.keys().next().value!);
        }
        try {
          return (await entry.pending).respond(req);
        } catch (e) {
          details.delete(id);
          return Response.json({ error: String(e) }, { status: 503 });
        }
      }
      const document = route.match(
        /^api\/documents\/([a-f0-9]{24})\/([A-Za-z0-9._-]+\.md)$/i,
      );
      if (document && req.method === "GET") {
        try {
          const run = store.run(document[1]);
          if (!run) return new Response("Unknown run", { status: 404 });
          const config = read(path.join(run.directory, "config.json")),
            rootDir = fs.realpathSync(config.docsDir ?? run.directory),
            file = fs.realpathSync(path.join(rootDir, document[2]));
          if (!within(rootDir, file) || fs.statSync(file).size > 256000)
            return new Response("Document unavailable", { status: 403 });
          return new Response(Bun.file(file), {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Referrer-Policy": "no-referrer",
              "X-Content-Type-Options": "nosniff",
            },
          });
        } catch {
          return new Response("Document unavailable", { status: 404 });
        }
      }
      if (route.startsWith("api/")) {
        if (req.method !== "POST" || req.headers.get("origin") !== url.origin)
          return new Response("Forbidden", { status: 403 });
        try {
          const body = (await req.json()) as any;
          if (route === "api/stop") {
            const run = store.run(body.id);
            if (!run) throw Error("Unknown run");
            const result = await bridge({
              op: "stop",
              options: { "run-dir": run.directory },
            });
            return Response.json(result);
          }
          if (route === "api/judge") {
            const run = store.run(body.id);
            if (
              !run ||
              !["accepted", "changes_required"].includes(body.verdict) ||
              typeof body.report !== "string" ||
              !body.report.trim() ||
              body.report.length > 10000
            )
              throw Error("Supply a judgment and concise reason for this run");
            const file = path.join(
              root,
              "judgments",
              `${body.id}-${crypto.randomUUID()}.md`,
            );
            fs.mkdirSync(path.dirname(file), { recursive: true });
            await Bun.write(file, body.report);
            const result = await bridge({
              op: "judge",
              options: {
                "run-dir": run.directory,
                actor: "human",
                verdict: body.verdict,
                "report-file": file,
              },
            });
            details.delete(body.id);
            refreshedAt = 0;
            const decision = store.decision(body.id);
            if (decision)
              store.updateDecision(decision.id, "resolved", {
                reason: "Human judgment recorded",
                humanVerdict: body.verdict,
              });
            return Response.json({
              ...result,
              message: "Human judgment recorded",
            });
          }
          if (route === "api/retry-notification") {
            store.retry(body.id, body.reconciled === true);
            return Response.json({ queued: true });
          }
          return new Response("Unknown action", { status: 404 });
        } catch (e) {
          return Response.json({ error: String(e) }, { status: 400 });
        }
      }
      if (req.method !== "GET")
        return new Response("Method not allowed", { status: 405 });
      if (
        route === "" ||
        route === "index.html" ||
        /^runs\/[a-f0-9]{24}$/.test(route)
      )
        return new Response(indexHtml, {
          headers: {
            "Content-Type": "text/html",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          },
        });
      // Only built asset basenames are exposed, never arbitrary local files.
      if (!/^[A-Za-z0-9_.-]+\.(js|css|svg|ico|map)$/.test(route))
        return new Response("Not found", { status: 404 });
      const file = Bun.file(path.join(assetRoot, route));
      return (await file.exists())
        ? new Response(file, { headers: { "Referrer-Policy": "no-referrer" } })
        : new Response("Not found", { status: 404 });
    },
  });
  config.port = server.port;
  save(configFile, config);
  save(path.join(root, "daemon.json"), {
    pid: process.pid,
    url: `http://127.0.0.1:${server.port}${prefix}`,
    instance: config.instance,
  });
  store.recover();
  if (options.legacy) importLegacy(store);
  // Catalog/detail reads follow browser demand; callbacks run independently.
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await tickWatches(store);
    } catch (e) {
      console.error(e);
    } finally {
      busy = false;
    }
  };
  const watchInterval = options.background
    ? setInterval(() => void tick(), 30000)
    : null;
  let decisionBusy = false;
  const decide = async () => {
    if (decisionBusy) return;
    decisionBusy = true;
    try {
      await tickDecisions(store);
    } catch (e) {
      console.error(e);
    } finally {
      decisionBusy = false;
    }
  };
  const decisionInterval = options.background
    ? setInterval(() => void decide(), 2000)
    : null;
  if (options.background) void tick();
  console.log(
    JSON.stringify({
      url: `http://127.0.0.1:${server.port}${prefix}`,
      pid: process.pid,
    }),
  );
  return {
    server,
    store,
    url: `http://127.0.0.1:${server.port}${prefix}`,
    close: () => {
      if (watchInterval) clearInterval(watchInterval);
      if (decisionInterval) clearInterval(decisionInterval);
      server.stop(true);
    },
  };
}
if (import.meta.main)
  serve().catch((e) => {
    console.error(String(e));
    process.exitCode = 1;
  });

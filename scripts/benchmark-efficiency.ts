// Read-only local benchmark; never submits workers or callbacks.
import path from "node:path";
import {Store} from "../src/store";
import {snapshot} from "../src/catalog";
import {home, read, projectRoot} from "../src/paths";
const store = new Store();
const bytes = (s: string) => Buffer.byteLength(s);
const start = performance.now();
const listing = await snapshot(store);
const coldMs = performance.now() - start;
const warmStart = performance.now();
await snapshot(store);
const warmMs = performance.now() - warmStart;
const cli = [];
for (let i = 0; i < 5; i++) {
  const at = performance.now();
  const child = Bun.spawn([process.execPath, "src/cli.ts", "list"], {cwd: projectRoot, stdout: "pipe", stderr: "pipe"});
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw Error(err);
  cli.push({ms: Math.round(performance.now() - at), bytes: bytes(out)});
}
const baselineFile = path.join(projectRoot, "work/efficiency-baseline.json");
const baseline = await Bun.file(baselineFile).exists()
  ? read(baselineFile)
  : read(path.join(projectRoot, "docs/efficiency-metrics.json")).baseline;
const daemon = read(path.join(home, "daemon.json"));
const first = await fetch(daemon.url + "api/snapshot"), body = await first.text();
if (!first.ok) throw Error(`HTTP ${first.status}`);
const second = await fetch(daemon.url + "api/snapshot", {headers: {"If-None-Match": first.headers.get("etag")!}});
const detailId = baseline.snapshot.largest[0].id;
const detailResponse = await fetch(daemon.url + "api/runs/" + detailId), detail = await detailResponse.text();
const result = {
  measuredAt: new Date().toISOString(), baseline,
  after: {snapshot: {bytes: bytes(body), coldMs: Math.round(coldMs), warmMs: Math.round(warmMs), runs: listing.runs.length, active: listing.runs.filter(r => r.active).length},
    unchanged: {status: second.status, bodyBytes: bytes(await second.text())},
    selectedDetail: {id: detailId, status: detailResponse.status, bytes: bytes(detail)},
    list: {samples: cli, medianMs: [...cli].sort((a, b) => a.ms - b.ms)[2].ms}},
  summaryPayloadReductionPercent: +(100 * (1 - bytes(body) / baseline.snapshot.bytes)).toFixed(2),
  limits: ["Payload bytes and timings are local measurements, not model tokens or billed quota.", "Baseline timing is one sample; after CLI timing has five samples. OS cache and machine load vary.", "Snapshot summary excludes selected detail, which now has its own conditional endpoint.", "No worker inference was purchased for this audit."]
};
await Bun.write(path.join(projectRoot, "docs/efficiency-metrics.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
store.close();

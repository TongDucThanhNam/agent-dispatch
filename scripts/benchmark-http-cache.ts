import { createHash } from "node:crypto";
import { prepareJson } from "../src/http-cache";

// Synthetic unchanged polling workload; this is not an end-to-end benchmark.
const payload = {
  at: Date.now(),
  runs: Array.from({ length: 100 }, (_, id) => ({
    id,
    objective: `Verify workflow ${id}`,
    status: "running",
    tasks: Array.from({ length: 8 }, (_, task) => ({
      id: task,
      status: "accepted",
    })),
  })),
};
const { at, ...content } = payload;
const previousEtag =
  '"' +
  createHash("sha256").update(JSON.stringify(content)).digest("hex") +
  '"';
const prepared = prepareJson(payload);
const request = new Request("http://localhost/api/snapshot", {
  headers: {
    "If-None-Match": prepared
      .respond(new Request("http://localhost"))
      .headers.get("etag")!,
  },
});
function previousPoll() {
  const { at, ...content } = payload;
  const etag =
    '"' +
    createHash("sha256").update(JSON.stringify(content)).digest("hex") +
    '"';
  return etag === previousEtag
    ? new Response(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": "private, no-cache" },
      })
    : Response.json(payload);
}
function measure(operation: () => Response) {
  for (let i = 0; i < 100; i++) operation();
  const samples = Array.from({ length: 5 }, () => {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) operation();
    return performance.now() - start;
  }).sort((a, b) => a - b);
  return Number(samples[2]!.toFixed(2));
}
console.log(
  JSON.stringify(
    {
      bun: Bun.version,
      payloadBytes: Buffer.byteLength(JSON.stringify(payload)),
      pollsPerSample: 1000,
      medianMs: {
        previous: measure(previousPoll),
        prepared: measure(() => prepared.respond(request)),
      },
    },
    null,
    2,
  ),
);

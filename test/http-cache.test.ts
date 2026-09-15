import { expect, test } from "bun:test";
import { prepareJson } from "../src/http-cache";

const request = (etag?: string) =>
  new Request("http://localhost/api/snapshot", {
    headers: etag ? { "If-None-Match": etag } : {},
  });

test("prepared JSON is reusable and invalidates data changes, not sampling time", async () => {
  const value = { at: 1, runs: [{ status: "running" }], catalogError: null };
  const cached = prepareJson(value);
  const first = cached.respond(request());
  const etag = first.headers.get("etag")!;
  expect(await first.json()).toEqual(value);
  expect(await cached.respond(request()).json()).toEqual(value);
  const unchanged = prepareJson({ ...value, at: 2 }).respond(request(etag));
  expect(unchanged.status).toBe(304);
  expect(await unchanged.text()).toBe("");
  expect(unchanged.headers.get("cache-control")).toBe("private, no-cache");
  expect(
    prepareJson({ ...value, runs: [{ status: "complete" }] }).respond(
      request(etag),
    ).status,
  ).toBe(200);
  expect(
    prepareJson({ ...value, catalogError: "Read failed" }).respond(
      request(etag),
    ).status,
  ).toBe(200);
});

test("conditional reads accept weak, strong, list and wildcard validators", () => {
  const cached = prepareJson({ at: 1, runs: [] });
  const etag = cached.respond(request()).headers.get("etag")!;
  for (const validator of [etag, etag.slice(2), `"old", ${etag}`, "*"])
    expect(cached.respond(request(validator)).status).toBe(304);
  expect(cached.respond(request('"other"')).status).toBe(200);
});

test("repeated polls do not serialize the prepared payload again", () => {
  let serialized = 0;
  const cached = prepareJson({
    runs: {
      toJSON() {
        serialized++;
        return [];
      },
    },
  });
  const preparedCount = serialized;
  const etag = cached.respond(request()).headers.get("etag")!;
  for (let i = 0; i < 100; i++) cached.respond(request(etag));
  expect(serialized).toBe(preparedCount);
});

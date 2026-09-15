/** Prepare immutable JSON once per data refresh, rather than once per poll. */
export function prepareJson(value: Record<string, unknown>) {
  const { at, ...content } = value;
  // `at` is a sampling timestamp, not a change in the represented data.
  const etag =
    'W/"' +
    new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(content))
      .digest("hex") +
    '"';
  const body = JSON.stringify(value);
  return {
    respond(req: Request) {
      const headers = {
        ETag: etag,
        "Cache-Control": "private, no-cache",
        "Content-Type": "application/json; charset=utf-8",
      };
      const validators = req.headers.get("if-none-match");
      const matches = validators?.split(",").some((value) => {
        const tag = value.trim();
        return tag === "*" || tag.replace(/^W\//, "") === etag.slice(2);
      });
      return matches
        ? new Response(null, { status: 304, headers })
        : new Response(body, { headers });
    },
  };
}

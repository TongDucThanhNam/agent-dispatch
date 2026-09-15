export function decisionPolicy(raw: any = {}) {
  const allowed = [
    "route",
    "effort",
    "maxCalls",
    "maxPacketBytes",
    "timeoutMs",
  ];
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).some((k) => !allowed.includes(k))
  )
    throw Error("Invalid decision policy field");
  const route = raw.route ?? "compact",
    effort = raw.effort ?? "high";
  if (!["compact", "thread", "local"].includes(route))
    throw Error("Decision route must be compact, thread or local");
  if (!["low", "medium", "high", "xhigh", "max", "ultra"].includes(effort))
    throw Error("Invalid Astra decision effort");
  const number = (key: string, fallback: number, low: number, high: number) => {
    const n = raw[key] ?? fallback;
    if (!Number.isInteger(n) || n < low || n > high)
      throw Error(`Invalid decision ${key}`);
    return n;
  };
  return {
    route,
    effort,
    maxCalls: number("maxCalls", 2, 0, 10),
    maxPacketBytes: number("maxPacketBytes", 24000, 4000, 48000),
    timeoutMs: number("timeoutMs", 180000, 1000, 600000),
  };
}

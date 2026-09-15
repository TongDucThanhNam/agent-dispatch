// Only dispatcher-owned error categories select this path; worker report text
// never grants permission to retry, spend quota or alter an acceptance contract.
export function dispatcherDiagnosis(state: any): string | null {
  if (state.status !== "needs_replan" || !state.error) return null;
  const attempts = Object.values(state.tasks ?? {}).reduce((n: number, t: any) => n + (t.attempts?.length ?? 0), 0);
  if (state.error.kind !== "source_audit" && !(state.error.kind === "workflow_error" && attempts === 0)) return null;
  return `${attempts === 0 ? "Dispatcher failed before any worker attempt" : "Dispatcher source audit failed"}: ${String(state.error.message).slice(0, 1500)}`;
}

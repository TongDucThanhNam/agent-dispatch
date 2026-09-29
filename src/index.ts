// Library entry point: the same modules the CLI uses, for tests and embedding.
// The stable contract for agents is the CLI protocol (see assets/guide/core.md), not this API.
export { nodeExecutable, CLI_ENTRY, CLI_NAME } from './core/paths.ts';
export { PROTOCOL_VERSION, prune, okEnvelope, errorEnvelope, writeOk, writeError } from './protocol/output.ts';
export { CliError, EXIT_CODES, toCliError, labelled } from './protocol/errors.ts';
export { WORKERS, validateConfig, defaultPaths, shortRef, driftOf, configuredEffort } from './core/config.ts';
export { acquireProjectLock, lockPathFor, readLock, lockHeld } from './core/lock.ts';
export { MAX_ASSIGNMENT_CHARACTERS, readAssignment, inspectProject } from './core/preflight.ts';
export { worktreeFingerprint, compareFingerprints, describeChanges } from './core/worktree.ts';
export { servePanel } from './core/panel.ts';
export { TERMINAL, finishResult, callbackMessage, notifyOnce, publicState, stopOwnedWorker, buildPrompt, supervise, isStale } from './core/supervisor.ts';
export { compactStatus, statusSummary, isSettled, qualified, capChanged, markReview } from './core/status.ts';
export { prepare, check, launch, resume, linkDiscovery, resolveCodexSelection } from './core/launch.ts';
export { resolveRun, listRuns, describeRun, activeRuns } from './core/runs.ts';
export { registerRun, readRun, createCatalog, serveDashboard, proxyAction, ensureDashboard, healthy, defaultRoot } from './monitor/hub.ts';
export { clean, classifyError, openTelemetry, assess } from './monitor/monitor-core.ts';
export { readEventContent, readEventPreviews, readToolCallId } from './monitor/event-content.ts';
export { readToolImage } from './monitor/event-images.ts';
export { readTrajectory } from './monitor/trajectory.ts';
export { sessionExportEntries, loadRunForExport, exportRunToFile, zipStream } from './monitor/session-export.ts';
export { modelCatalog, nativeSelection, buildNativeInvocation, verifyNative } from './workers/zcode/native.ts';
export { desktopHandoff } from './workers/zcode/desktop.ts';
export { readAgySelection, buildAgyArgs, createAgyProjection, startAgy } from './workers/agy/adapter.ts';
export { readCodexSelection, buildCodexArgs, codexEnv, codexError, createCodexProjection, startCodex, locateRollout } from './workers/codex/adapter.ts';
export { guideText, templateText, detectOrchestrator, TOPICS, TEMPLATES } from './guide/guide.ts';
export { installSkills, skillState, thinSkill, SKILL_NAMES } from './skills/install.ts';

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function desktopHandoff(config, state) {
  if ((config.workerKind ?? 'zcode') !== 'zcode') throw Error('Desktop session handoff is available for ZCode only.');
  if (!state.workerExited || !/^sess_[A-Za-z0-9_-]+$/.test(state.sessionId ?? '')) throw Error('Wait for the worker to exit and record its session before continuing in ZCode.');
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  let session;
  try { session = db.prepare('SELECT id, directory, parent_id FROM session WHERE id = ?').get(state.sessionId); }
  finally { db.close(); }
  const normalize = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  if (!session || session.parent_id || normalize(session.directory) !== normalize(config.project)) throw Error('The recorded session does not belong to this project or is a child session.');
  return {
    sessionId: session.id, workspace: config.project,
    desktopUrl: `zcode://workspace/open?path=${encodeURIComponent(config.project)}`,
    tui: { executable: 'zcode', args: ['native', 'tui', '--cwd', config.project, '--resume', session.id] },
    instructions: 'Open this workspace in ZCode; its task list imports the shared sessions. If already open, reopen the workspace to refresh. Select the recorded session. Continue from only one client at a time.',
  };
}

// Dashboard UI preview against the real run registry (read-only).
// Serves on a fixed port beside the shared hub, never writes hub.json, reloads
// the page on every request and refuses Stop/Retry so a live run is never touched.
import { serveDashboard, defaultRoot } from '../src/monitor/hub.ts';

const port = Number(process.env.PORT ?? 4780);
const token = 'dev0'.repeat(12).replace(/[^a-f0-9]/g, '0');
const panel = await serveDashboard({ root: defaultRoot(), port, token, dev: true,
  action: async () => { throw new Error('Actions are disabled in the dev preview.'); } });
console.log(panel.url);

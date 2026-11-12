import {setupMcodeWorker} from '../src/workers/mcode/worker-profile.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('bun run setup:mcode-worker [--dry-run] [--force]\nRequires agent-dispatch mcode setup. Installs only a separate Custom Agent; does not change the default or invoke a model.');
} else {
  const unknown = args.find(arg => !['--dry-run', '--force'].includes(arg));
  if (unknown) throw Error(`Unknown option: ${unknown}`);
  try { console.log(JSON.stringify(await setupMcodeWorker({dryRun: args.includes('--dry-run'), force: args.includes('--force')}))); }
  catch (error: any) { console.error(error.message); process.exitCode = 1; }
}

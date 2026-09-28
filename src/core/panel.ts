import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { asset } from './paths.ts';
import { clean } from '../monitor/monitor-core.ts';

const HTML = fs.readFileSync(asset('web', 'monitor.html'));

type Actions = Partial<Record<'stop' | 'retry-notification', () => Promise<string>>>;

/** Per-run loopback control panel; its URL carries a random token and only allows the listed actions. */
export async function servePanel(config: unknown, getState: () => unknown, actions: Actions = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  let port = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'self'");
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    const expectedHost = `127.0.0.1:${port}`;
    if (req.headers.host !== expectedHost) return send(403, { error: 'Invalid host.' });
    const url = new URL(req.url!, `http://${expectedHost}`), base = `/${token}/`;
    if (!url.pathname.startsWith(base)) return send(404, { error: 'Unknown monitor.' });
    const route = url.pathname.slice(base.length);
    if (req.method === 'GET' && route === '') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(HTML); }
    if (req.method === 'GET' && route === 'status') return send(200, getState());
    if (req.method !== 'POST') return send(405, { error: 'Method not allowed.' });
    if (req.headers.origin && req.headers.origin !== `http://${expectedHost}`) return send(403, { error: 'Cross-origin actions are not allowed.' });
    const action = (route === 'stop' || route === 'retry-notification') ? actions[route] : undefined;
    if (!action) return send(403, { error: 'This view does not allow that action.' });
    req.resume();
    try { return send(200, { message: await action() }); }
    catch (error) { return send(409, { error: clean(error.message) }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(undefined)); });
  port = (server.address() as any).port;
  return { server, url: `http://127.0.0.1:${port}/${token}/`, close: () => new Promise(resolve => server.close(resolve)) };
}

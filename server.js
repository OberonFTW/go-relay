const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.RELAY_PASSWORD;
const ORIGIN = process.env.ALLOW_ORIGIN || '*';
const RUN_MS = (+process.env.RUN_SECONDS || 120) * 1000;
const BUILD_MS = (+process.env.BUILD_SECONDS || 240) * 1000;
const MAX_OUT = 200 * 1024;
const MAX_BODY = 2e6;
if (!PASSWORD || PASSWORD.length < 8) { console.error('Set RELAY_PASSWORD (at least 8 characters).'); process.exit(1); }

const safeName = n => typeof n === 'string' && /^[\w.\-]+(\/[\w.\-]+)*$/.test(n) && !n.includes('..') && n.length < 200;

// run a command with a time limit and an output limit; the whole process group is killed on timeout
function exec(cmd, args, cwd, ms) {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { cwd, detached: true, env: Object.assign({}, process.env, { HOME: process.env.HOME || os.homedir(), CGO_ENABLED: process.env.CGO_ENABLED || '1' }) });
    let out = '', size = 0, timedOut = false, truncated = false;
    const take = d => { if (size < MAX_OUT) { out += d.toString(); size += d.length; } else if (!truncated) { truncated = true; out += '\n... output cut off (too long)\n'; try { process.kill(-p.pid, 'SIGKILL'); } catch (e) { } } };
    p.stdout.on('data', take); p.stderr.on('data', take);
    const t = setTimeout(() => { timedOut = true; try { process.kill(-p.pid, 'SIGKILL'); } catch (e) { } }, ms);
    p.on('close', code => { clearTimeout(t); resolve({ code, out, timedOut }); });
    p.on('error', e => { clearTimeout(t); resolve({ code: 127, out: String(e.message), timedOut: false }); });
  });
}

let busy = Promise.resolve(); // one job at a time keeps a small free server from running out of memory
const queue = fn => { const r = busy.then(fn, fn); busy = r.catch(() => { }); return r; };

async function runProject(body) {
  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length || files.length > 200) throw new Error('send between 1 and 200 files');
  const mode = ['run', 'build', 'vet', 'test'].includes(body.mode) ? body.mode : 'run';
  const targets = Array.isArray(body.targets) && body.targets.every(t => /^[\w.\-]+\.go$/.test(t)) ? body.targets : [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goj-'));
  try {
    for (const f of files) {
      if (!safeName(f.name) || typeof f.text !== 'string') throw new Error('bad file: ' + f.name);
      const full = path.join(dir, f.name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f.text);
    }
    if (!files.some(f => f.name === 'go.mod')) await exec('go', ['mod', 'init', 'devpad'], dir, 20000);
    const tidy = await exec('go', ['mod', 'tidy'], dir, BUILD_MS);
    if (tidy.timedOut) return { ok: false, output: 'go mod tidy took longer than ' + BUILD_MS / 1000 + ' seconds and was stopped.\n' };
    let args;
    if (mode === 'run') args = ['run'].concat(targets.length ? targets : ['.']);
    else args = [mode].concat(targets.length ? targets : ['./...']);
    // compile first (generous limit), then run (short limit) so downloads never count against the program's run time
    if (mode === 'run') {
      const b = await exec('go', ['build', '-o', path.join(dir, '.prog')].concat(targets.length ? targets : ['.']), dir, BUILD_MS);
      if (b.timedOut) return { ok: false, output: 'Compiling took longer than ' + BUILD_MS / 1000 + ' seconds and was stopped.\n' + b.out };
      if (b.code !== 0) return { ok: false, output: b.out };
      const r = await exec(path.join(dir, '.prog'), [], dir, RUN_MS);
      if (r.timedOut) return { ok: false, output: r.out + '\n[stopped: the program ran longer than ' + RUN_MS / 1000 + ' seconds]\n' };
      return { ok: r.code === 0, output: r.out + (r.code ? '\nexit status ' + r.code + '\n' : '') };
    }
    const r = await exec('go', args, dir, mode === 'test' ? BUILD_MS + RUN_MS : BUILD_MS);
    if (r.timedOut) return { ok: false, output: r.out + '\n[stopped: took too long]\n' };
    return { ok: r.code === 0, output: r.out };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' });
  res.end(JSON.stringify(obj));
}

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET' && req.url === '/') return send(res, 200, { ok: true, service: 'go-relay', mode: 'local' });
  if (req.method !== 'POST' || req.url !== '/run') return send(res, 404, { error: 'not found' });
  if (req.headers.authorization !== 'Bearer ' + PASSWORD) return send(res, 401, { error: 'wrong or missing password' });
  let data = '', dead = false;
  req.on('data', c => { data += c; if (data.length > MAX_BODY) { dead = true; req.destroy(); } });
  req.on('end', async () => {
    if (dead) return;
    try { send(res, 200, await queue(() => runProject(JSON.parse(data || '{}')))); }
    catch (e) { send(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  });
}).listen(PORT, () => console.log('go-relay (local Go) listening on ' + PORT));

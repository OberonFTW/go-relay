const http = require('http');
const { CodeSandbox } = require('@codesandbox/sdk');

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.RELAY_PASSWORD;
const ORIGIN = process.env.ALLOW_ORIGIN || '*';
if (!process.env.CSB_API_KEY || !PASSWORD) {
  console.error('Missing CSB_API_KEY or RELAY_PASSWORD environment variable.');
  process.exit(1);
}
const sdk = new CodeSandbox(process.env.CSB_API_KEY);

let box = null; // { sandboxId, client } kept between requests so only the first run waits for a VM
async function getClient() {
  if (box) return box.client;
  const tpl = process.env.CSB_TEMPLATE;
  const sandbox = await sdk.sandboxes.create(tpl ? { id: tpl } : undefined);
  const client = await sandbox.connect();
  box = { sandboxId: sandbox.id, client };
  return client;
}

const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
const safeName = n => /^[\w.\-]+(\/[\w.\-]+)*$/.test(n) && !n.includes('..');

async function runProject(body) {
  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length || files.length > 200) throw new Error('send between 1 and 200 files');
  const mode = ['run', 'build', 'vet', 'test'].includes(body.mode) ? body.mode : 'run';
  const target = Array.isArray(body.targets) && body.targets.length && body.targets.every(t => /^[\w.\-]+\.go$/.test(t)) ? body.targets.join(' ') : '';
  const client = await getClient();
  const dir = 'devpad_' + Date.now();
  await client.commands.run('mkdir -p ' + dir);
  for (const f of files) {
    if (!safeName(f.name) || typeof f.text !== 'string') throw new Error('bad file: ' + f.name);
    const sub = f.name.includes('/') ? f.name.replace(/\/[^/]*$/, '') : '';
    if (sub) await client.commands.run('mkdir -p ' + shq(dir + '/' + sub));
    await client.fs.writeTextFile(dir + '/' + f.name, f.text);
  }
  const hasMod = files.some(f => f.name === 'go.mod');
  const prep = (hasMod ? '' : 'go mod init devpad >/dev/null 2>&1; ') + 'go mod tidy >/dev/null 2>&1; ';
  const what = mode === 'run' ? 'go run ' + (target || '.') : 'go ' + mode + ' ' + (target || './...');
  let output = '', ok = true;
  try {
    const r = await client.commands.run('cd ' + dir + ' && ' + prep + what + ' 2>&1');
    output = typeof r === 'string' ? r : (r && (r.output || r.stdout)) || '';
  } catch (e) {
    ok = false;
    output = String((e && e.message) || e);
  }
  try { await client.commands.run('rm -rf ' + dir); } catch (e) { /* ignore */ }
  return { ok, output };
}

function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
  });
  res.end(JSON.stringify(obj));
}

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET' && req.url === '/') return send(res, 200, { ok: true, service: 'go-relay' });
  if (req.method !== 'POST' || req.url !== '/run') return send(res, 404, { error: 'not found' });
  if (req.headers.authorization !== 'Bearer ' + PASSWORD) return send(res, 401, { error: 'wrong or missing password' });
  let data = '';
  req.on('data', c => { data += c; if (data.length > 2e6) req.destroy(); });
  req.on('end', async () => {
    try {
      send(res, 200, await runProject(JSON.parse(data || '{}')));
    } catch (e) {
      box = null; // next request starts a fresh sandbox
      send(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });
}).listen(PORT, () => console.log('go-relay listening on ' + PORT));

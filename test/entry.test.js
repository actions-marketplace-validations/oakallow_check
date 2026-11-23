// Runs src/main.js as the runner would: inputs in INPUT_* env vars, outputs
// and the job summary written to files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

async function fakeMcp(text, isError) {
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text }], isError } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

function run(env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(root, 'src/main.js')], { env: { PATH: process.env.PATH, ...env } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

function files() {
  const dir = mkdtempSync(join(tmpdir(), 'oak-action-'));
  const paths = { GITHUB_OUTPUT: join(dir, 'out'), GITHUB_STEP_SUMMARY: join(dir, 'summary') };
  for (const p of Object.values(paths)) writeFileSync(p, '');
  return paths;
}

test('allowed exits 0, masks the token, writes outputs and summary', async () => {
  const api = await fakeMcp('Permission: allowed. oakallow permits `deploy` without approval. Signed decision receipt: REF-BBBB2222-0002.', false);
  const f = files();
  try {
    const { code, out } = await run({ ...f, 'INPUT_AGENT-TOKEN': 'test-token-not-real', INPUT_TOOL: 'deploy', 'INPUT_API-URL': api.url });
    assert.equal(code, 0, out);
    assert.match(out, /::add-mask::test-token-not-real/);
    const outputs = readFileSync(f.GITHUB_OUTPUT, 'utf8');
    assert.match(outputs, /permission<<ghadelimiter_[^\n]+\nallowed\n/);
    assert.match(outputs, /reference-id<<ghadelimiter_[^\n]+\nREF-BBBB2222-0002\n/);
    assert.match(readFileSync(f.GITHUB_STEP_SUMMARY, 'utf8'), /### oakallow check/);
  } finally { await api.close(); }
});

test('refused exits 1 with an error annotation', async () => {
  const api = await fakeMcp('Tool deploy was disabled by policy (default_deny).', true);
  const f = files();
  try {
    const { code, out } = await run({ ...f, 'INPUT_AGENT-TOKEN': 'test-token-not-real', INPUT_TOOL: 'deploy', 'INPUT_API-URL': api.url });
    assert.equal(code, 1);
    assert.match(out, /::error::oakallow: deploy was not permitted: Tool deploy was disabled by policy/);
  } finally { await api.close(); }
});

test('missing required input exits 1', async () => {
  const { code, out } = await run({ ...files(), 'INPUT_AGENT-TOKEN': 'test-token-not-real' });
  assert.equal(code, 1);
  assert.match(out, /Input required and not supplied: tool/);
});

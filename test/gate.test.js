// Drives the gate against a fake oakallow MCP endpoint whose replies are copied
// from oakallow-auth-worker/src/routes/mcp.js, so a wording change there shows
// up here as a failing test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createClient } from '../src/client.js';
import { runGate, parseConfig, githubContext, defaultReason } from '../src/gate.js';

const TOKEN = 'test-token-not-real';
const REF = 'REF-1A2B3C4D-9F8E';

export const replies = {
  allowed: (tool) => ({ text: `Permission: allowed. oakallow permits \`${tool}\` without approval. oakallow does not execute tools — run the action on its own connector now. Signed decision receipt: REF-AAAA1111-0001.`, isError: false }),
  sent: () => ({ text: `Request has been sent for approval. Reference number: ${REF}. Please share this reference with your approver — they will open oakallow (mobile or desktop app) to review and approve it. `, isError: true }),
  stillPending: () => ({ text: `Request is still awaiting approval. Reference number: ${REF}. The approver needs to open oakallow and approve this reference before the call can execute. Use check_approval_status with reference=${REF} to poll the status.`, isError: true }),
  disabled: (tool) => ({ text: `Tool ${tool} was disabled by policy (tool_not_enabled_in_org). Signed decision receipt: REF-DDDD0000-0002.`, isError: true }),
  draft: (tool) => ({ text: `Tool ${tool} is pending review. It has been recorded as a discovered tool (draft) in your Oakallow activity and must be enabled by an admin in Recently Discovered before it can be used. No approval request was created.`, isError: true }),
  status: (status, decidedBy) => ({
    text: [`Reference: ${REF}`, 'Tool: deploy', `Status: ${status}`, 'Created: 2026-11-22 18:00:00',
      ...(decidedBy ? ['Decided: 2026-11-22 18:05:00', `Decided by: ${decidedBy}`] : []), 'Expires: 2026-11-22T19:00:00Z'].join('\n'),
    isError: false,
  }),
};

// `script(call)` returns either { http: [status, body, headers] } or a tool reply { text, isError }.
async function fakeMcp(script) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const call = { path: req.url, auth: req.headers.authorization, accept: req.headers.accept, body, name: body.params?.name, args: body.params?.arguments };
    calls.push(call);
    const out = script(call, calls);
    if (out.http) {
      const [status, b, headers = {}] = out.http;
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      return res.end(JSON.stringify(b));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: out.text }], isError: out.isError } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

function cfgFor(url, overrides = {}) {
  const inputs = { 'api-url': url, tool: 'deploy', ...overrides };
  return parseConfig((name, fallback) => inputs[name] ?? fallback);
}

const gh = githubContext({
  GITHUB_REPOSITORY: 'acme/app', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2',
  GITHUB_WORKFLOW: 'deploy', GITHUB_ACTOR: 'octo', GITHUB_SHA: 'abcdef1234', GITHUB_REF_NAME: 'main',
});

function makeIo() {
  const lines = [];
  return { lines, info: (m) => lines.push(m), notice: (m) => lines.push(m), warning: (m) => lines.push(`WARN ${m}`) };
}

const noSleep = async () => {};
const client = (url, extra = {}) => createClient({ apiUrl: url, agentToken: TOKEN, sleepFn: noSleep, ...extra });

test('allowed: one tools/call on the governed tool, receipt captured', async () => {
  const api = await fakeMcp((c) => replies.allowed(c.name));
  try {
    const r = await runGate({ cfg: cfgFor(api.url), gh, client: client(api.url), io: makeIo() });
    assert.equal(r.ok, true);
    assert.equal(r.permission, 'allowed');
    assert.equal(r.referenceId, 'REF-AAAA1111-0001');
    assert.equal(api.calls.length, 1);
    const c = api.calls[0];
    assert.equal(c.path, '/mcp');
    assert.equal(c.auth, `Bearer ${TOKEN}`);
    assert.match(c.accept, /application\/json/);
    assert.equal(c.body.method, 'tools/call');
    assert.equal(c.name, 'deploy');
    assert.deepEqual(Object.keys(c.args), ['reason'], 'only reason is sent; no org, agent or check_permission');
  } finally { await api.close(); }
});

test('resource, method and tenant are sent as prefixed oakallow_ arguments', async () => {
  const api = await fakeMcp((c) => replies.allowed(c.name));
  try {
    await runGate({ cfg: cfgFor(api.url, { resource: 'production', method: 'deploy', tenant: 'acme' }), gh, client: client(api.url), io: makeIo() });
    const args = api.calls[0].args;
    assert.equal(args.oakallow_resource, 'production');
    assert.equal(args.oakallow_method, 'deploy');
    assert.equal(args.oakallow_tenant, 'acme');
    assert.ok(!('resource_id' in args) && !('method' in args));
  } finally { await api.close(); }
});

test('a target not set up in oakallow fails the step', async () => {
  const api = await fakeMcp(() => ({ text: 'Resource "prodution" is not set up in this oakallow org, so the call was refused. No approval request was created.', isError: true }));
  try {
    const r = await runGate({ cfg: cfgFor(api.url, { resource: 'prodution' }), gh, client: client(api.url), io: makeIo() });
    assert.equal(r.ok, false);
    assert.match(r.message, /not set up in this oakallow org/);
  } finally { await api.close(); }
});

test('never calls the free check_permission tool', async () => {
  const api = await fakeMcp((c) => (c.name === 'check_permission' ? { text: 'should not be called', isError: true } : replies.allowed(c.name)));
  try {
    await runGate({ cfg: cfgFor(api.url), gh, client: client(api.url), io: makeIo() });
    assert.ok(api.calls.every((c) => c.name !== 'check_permission'));
  } finally { await api.close(); }
});

test('disabled fails with oakallow\'s own text', async () => {
  const api = await fakeMcp((c) => replies.disabled(c.name));
  try {
    const r = await runGate({ cfg: cfgFor(api.url), gh, client: client(api.url), io: makeIo() });
    assert.equal(r.ok, false);
    assert.equal(r.permission, 'disabled');
    assert.match(r.message, /was disabled by policy \(tool_not_enabled_in_org\)/);
    assert.equal(api.calls.length, 1);
  } finally { await api.close(); }
});

test('draft (unregistered) tool fails closed', async () => {
  const api = await fakeMcp((c) => replies.draft(c.name));
  try {
    const r = await runGate({ cfg: cfgFor(api.url), gh, client: client(api.url), io: makeIo() });
    assert.equal(r.ok, false);
    assert.match(r.message, /pending review/);
  } finally { await api.close(); }
});

test('approval: polls check_approval_status by REF and passes when approved', async () => {
  let polls = 0;
  const api = await fakeMcp((c) => {
    if (c.name === 'deploy') return replies.sent();
    polls += 1;
    return polls < 3 ? replies.status('pending') : replies.status('approved', 'victoria');
  });
  try {
    const r = await runGate({ cfg: cfgFor(api.url), gh, client: client(api.url), io: makeIo(), sleepFn: noSleep });
    assert.equal(r.ok, true);
    assert.equal(r.permission, 'requires_approval');
    assert.equal(r.referenceId, REF);
    assert.equal(r.decision, 'approved');
    assert.equal(r.decidedBy, 'victoria');
    assert.equal(polls, 3);
    const pollCall = api.calls.find((c) => c.name === 'check_approval_status');
    assert.deepEqual(pollCall.args, { reference: REF });
    assert.equal(api.calls.filter((c) => c.name === 'deploy').length, 1, 'the governed tool is called once');
  } finally { await api.close(); }
});

test('an approval already pending from an earlier run is never used', async () => {
  const api = await fakeMcp((c) => (c.name === 'deploy' ? replies.stillPending() : replies.status('approved', 'sam')));
  try {
    const r = await runGate({ cfg: cfgFor(api.url), gh, client: client(api.url), io: makeIo(), sleepFn: noSleep });
    assert.equal(r.ok, false);
    assert.match(r.message, /already pending .*This run will not use it/);
    assert.equal(api.calls.filter((c) => c.name === 'check_approval_status').length, 0, 'never polls the other run\'s approval');
  } finally { await api.close(); }
});

for (const status of ['denied', 'expired', 'cancelled']) {
  test(`${status} fails`, async () => {
    const api = await fakeMcp((c) => (c.name === 'deploy' ? replies.sent() : replies.status(status, status === 'denied' ? 'sam' : null)));
    try {
      const r = await runGate({ cfg: cfgFor(api.url), gh, client: client(api.url), io: makeIo(), sleepFn: noSleep });
      assert.equal(r.ok, false);
      assert.equal(r.decision, status);
    } finally { await api.close(); }
  });
}

test('wait-for-approval false fails right after the request is made', async () => {
  const api = await fakeMcp(() => replies.sent());
  try {
    const r = await runGate({ cfg: cfgFor(api.url, { 'wait-for-approval': 'false' }), gh, client: client(api.url), io: makeIo() });
    assert.equal(r.ok, false);
    assert.equal(r.referenceId, REF);
    assert.equal(api.calls.length, 1);
  } finally { await api.close(); }
});

test('times out and fails, leaving the request to expire', async () => {
  let t = 0;
  const api = await fakeMcp((c) => (c.name === 'deploy' ? replies.sent() : replies.status('pending')));
  try {
    const r = await runGate({
      cfg: cfgFor(api.url, { 'max-wait-minutes': '1', 'poll-seconds': '30' }), gh, client: client(api.url), io: makeIo(),
      now: () => t, sleepFn: async (ms) => { t += ms; },
    });
    assert.equal(r.ok, false);
    assert.match(r.message, /stays pending in oakallow until it expires/);
  } finally { await api.close(); }
});

test('429 and 5xx while polling keep waiting', async () => {
  let polls = 0;
  const api = await fakeMcp((c) => {
    if (c.name === 'deploy') return replies.sent();
    polls += 1;
    if (polls <= 5) return { http: [429, { error: 'Rate limit exceeded' }, { 'Retry-After': '1' }] };
    if (polls <= 9) return { http: [503, { error: 'unavailable' }] };
    return replies.status('approved', 'victoria');
  });
  try {
    const r = await runGate({ cfg: cfgFor(api.url), gh, client: client(api.url), io: makeIo(), sleepFn: noSleep });
    assert.equal(r.ok, true);
  } finally { await api.close(); }
});

test('invalid agent token (401) fails with a hint', async () => {
  const api = await fakeMcp(() => ({ http: [401, { jsonrpc: '2.0', error: { code: -32001, message: 'Invalid agent token' }, id: null }] }));
  try {
    const r = await runGate({ cfg: cfgFor(api.url), gh, client: client(api.url), io: makeIo() });
    assert.equal(r.ok, false);
    assert.match(r.message, /Invalid agent token.*agent-token/);
  } finally { await api.close(); }
});

test('a JSON-RPC error fails closed', async () => {
  const api = await fakeMcp((c) => ({ http: [200, { jsonrpc: '2.0', id: c.body.id, error: { code: -32603, message: 'Internal error' } }] }));
  try {
    const r = await runGate({ cfg: cfgFor(api.url), gh, client: client(api.url), io: makeIo() });
    assert.equal(r.ok, false);
    assert.match(r.message, /Internal error/);
  } finally { await api.close(); }
});

test('an unrecognized status reply fails closed', async () => {
  const api = await fakeMcp((c) => (c.name === 'deploy' ? replies.sent() : { text: 'Something new', isError: false }));
  try {
    const r = await runGate({ cfg: cfgFor(api.url), gh, client: client(api.url), io: makeIo(), sleepFn: noSleep });
    assert.equal(r.ok, false);
    assert.match(r.message, /Unexpected approval status reply/);
  } finally { await api.close(); }
});

test('config validation', () => {
  assert.throws(() => cfgFor('http://api.example.com'), /https/);
  assert.throws(() => cfgFor('https://api.oakallow.io', { 'wait-for-approval': 'yes' }), /true or false/);
  assert.equal(cfgFor('https://api.oakallow.io', { 'poll-seconds': '2' }).pollSeconds, 10);
});

test('default reason comes from the run', () => {
  assert.equal(defaultReason(gh), 'GitHub Actions: acme/app workflow "deploy" on main @abcdef1 by octo');
});

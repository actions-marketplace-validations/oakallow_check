// oakallow MCP client for the two calls this action makes, both as
// JSON-RPC tools/call against the hosted MCP endpoint (POST {api-url}/mcp):
//   1. the governed tool itself      -> allowed, or an approval with a REF, or refused
//   2. check_approval_status         -> pending / approved / denied / expired / cancelled
// Auth is an agent token (oak_agent_...) as a Bearer header. The endpoint is
// stateless JSON (no SSE, no session), so no initialize round trip is needed.

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class OakallowError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function backoffMs(attempt, retryAfter) {
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 120) * 1000;
  return Math.min(2 ** attempt * 1000, 30000);
}

export function createClient({ apiUrl, agentToken, retries = 3, timeoutMs = 15000, sleepFn = sleep }) {
  const endpoint = `${apiUrl.replace(/\/+$/, '')}/mcp`;
  let nextId = 1;

  // Returns the tools/call result: { text, isError }.
  async function callTool(name, args) {
    const payload = { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } };
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let res;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${agentToken}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'oakallow-check-action/1',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        lastError = new OakallowError(`Network error calling oakallow: ${err.message}`, 0, null);
        if (attempt < retries) { await sleepFn(backoffMs(attempt, null)); continue; }
        throw lastError;
      }

      const raw = await res.text();
      let json = null;
      try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }

      if (!res.ok) {
        const message = json?.error?.message || json?.error || json?.message || `HTTP ${res.status}`;
        lastError = new OakallowError(typeof message === 'string' ? message : `HTTP ${res.status}`, res.status, json);
        if (RETRYABLE.has(res.status) && attempt < retries) {
          await sleepFn(backoffMs(attempt, res.headers.get('retry-after')));
          continue;
        }
        throw lastError;
      }

      if (json?.error) {
        throw new OakallowError(json.error.message || 'MCP error', res.status, json);
      }
      const result = json?.result;
      if (!result || !Array.isArray(result.content)) {
        throw new OakallowError('Unexpected response from oakallow MCP', res.status, json);
      }
      const text = result.content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
      return { text, isError: result.isError === true };
    }
    throw lastError;
  }

  return {
    callGovernedTool: (tool, reason, target = {}) => {
      const args = {};
      if (reason) args.reason = reason;
      if (target.resource) args.oakallow_resource = target.resource;
      if (target.method) args.oakallow_method = target.method;
      if (target.tenant) args.oakallow_tenant = target.tenant;
      return callTool(tool, args);
    },
    checkApprovalStatus: (reference) => callTool('check_approval_status', { reference }),
  };
}

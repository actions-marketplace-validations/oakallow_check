// Core flow over oakallow's MCP endpoint, kept free of process globals so
// tests can drive it. It uses MCP exactly as every agent does today:
//
// 1. tools/call <tool> with a reason
//      "Permission: allowed. ..."                         -> pass
//      "Request has been sent for approval. Reference number: REF-..."
//      "Request is still awaiting approval. Reference number: REF-..."
//                                                          -> wait on that REF
//      anything else (disabled, blocked, lockdown, draft)  -> fail with oakallow's text
// 2. check_approval_status { reference } until the status is final.
//
// Calling the governed tool is the billed call. check_permission (free,
// read-only) is deliberately not used. MCP has no cancel, so an approval
// still pending when the action stops waiting expires on its own TTL.

import { OakallowError, sleep } from './client.js';

export const DASHBOARD_APPROVALS_URL = 'https://oakallow.io/dashboard/approvals';
const MIN_POLL_SECONDS = 10;
const TERMINAL = new Set(['approved', 'denied', 'expired', 'cancelled']);

const ALLOWED_RE = /^Permission: allowed\b/;
const APPROVAL_RE = /(sent for approval|still awaiting approval)\. Reference number: (REF-[A-Z0-9]+-[A-Z0-9]+)/;
const RECEIPT_RE = /Signed decision receipt: (REF-[A-Z0-9]+-[A-Z0-9]+)/;
const STATUS_RE = /^Status: ([a-z_]+)\s*$/m;
const DECIDED_BY_RE = /^Decided by: (.+)$/m;

export function parseConfig(get) {
  const pollSeconds = Math.max(MIN_POLL_SECONDS, Number(get('poll-seconds', '30')) || 30);
  const maxWaitMinutes = Math.max(1, Number(get('max-wait-minutes', '60')) || 60);
  const waitRaw = get('wait-for-approval', 'true').toLowerCase();
  if (!['true', 'false'].includes(waitRaw)) throw new Error('wait-for-approval must be true or false');

  const apiUrl = get('api-url', 'https://api.oakallow.io');
  const parsed = new URL(apiUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !local) throw new Error('api-url must use https');

  return {
    apiUrl,
    tool: get('tool', ''),
    resource: get('resource', ''),
    method: get('method', ''),
    tenant: get('tenant', ''),
    reason: get('reason', ''),
    wait: waitRaw === 'true',
    pollSeconds,
    maxWaitMinutes,
  };
}

export function githubContext(env) {
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  const repo = env.GITHUB_REPOSITORY || '';
  const runId = env.GITHUB_RUN_ID || '';
  return {
    repo,
    runId,
    attempt: env.GITHUB_RUN_ATTEMPT || '1',
    runUrl: repo && runId ? `${server}/${repo}/actions/runs/${runId}` : '',
    workflow: env.GITHUB_WORKFLOW || '',
    actor: env.GITHUB_ACTOR || '',
    sha: (env.GITHUB_SHA || '').slice(0, 7),
    ref: env.GITHUB_REF_NAME || '',
  };
}

export function defaultReason(gh) {
  const parts = [
    gh.repo,
    gh.workflow && `workflow "${gh.workflow}"`,
    gh.ref && `on ${gh.ref}`,
    gh.sha && `@${gh.sha}`,
    gh.actor && `by ${gh.actor}`,
  ].filter(Boolean);
  // No run id: GitHub run ids are 10+ digit numbers, which oakallow's PII
  // filter redacts as phone numbers, leaving "(=some redacted text)".
  return `GitHub Actions: ${parts.join(' ')}`;
}

export async function runGate({ cfg, gh, client, io, now = () => Date.now(), sleepFn = sleep }) {
  const result = { permission: '', referenceId: '', decision: '', decidedBy: '', ok: false, message: '' };

  let first;
  try {
    first = await client.callGovernedTool(cfg.tool, cfg.reason || defaultReason(gh), {
      resource: cfg.resource, method: cfg.method, tenant: cfg.tenant,
    });
  } catch (err) {
    result.message = explainError('Permission check failed', err);
    return result;
  }

  if (!first.isError && ALLOWED_RE.test(first.text)) {
    result.permission = 'allowed';
    result.referenceId = first.text.match(RECEIPT_RE)?.[1] || '';
    result.ok = true;
    result.message = `${cfg.tool} is allowed`;
    io.info(`oakallow: ${cfg.tool} -> allowed${result.referenceId ? ` (${result.referenceId})` : ''}`);
    return result;
  }

  const approval = first.isError ? first.text.match(APPROVAL_RE) : null;
  if (!approval) {
    // disabled, blocked, lockdown, draft tool, paused server, or anything
    // unrecognized: fail closed and show oakallow's own explanation.
    result.permission = 'disabled';
    result.referenceId = first.text.match(RECEIPT_RE)?.[1] || '';
    result.message = `${cfg.tool} was not permitted: ${first.text}`;
    return result;
  }

  result.permission = 'requires_approval';
  result.referenceId = approval[2];
  if (approval[1] === 'still awaiting approval') {
    // oakallow returned an approval that was already pending for this agent
    // and tool, so it was requested by an earlier run with that run's reason.
    // Never wait on it: approving it would release this run without anyone
    // having seen this run's request.
    result.message =
      `Another request for ${cfg.tool} is already pending (${result.referenceId}), opened by an earlier run. ` +
      'This run will not use it. Deny it or let it expire in oakallow, then re-run.';
    return result;
  }
  io.info(`oakallow: ${cfg.tool} -> requires approval (${result.referenceId})`);

  if (!cfg.wait) {
    result.message = `${cfg.tool} requires approval (${result.referenceId}) and wait-for-approval is false`;
    return result;
  }

  io.notice(`Waiting for approval of ${cfg.tool}, reference ${result.referenceId}. Decide at ${DASHBOARD_APPROVALS_URL} or in the oakallow app.`);
  const deadline = now() + cfg.maxWaitMinutes * 60_000;

  while (true) {
    let statusText = null;
    try {
      const res = await client.checkApprovalStatus(result.referenceId);
      if (res.isError) {
        result.message = `Reading approval ${result.referenceId} failed: ${res.text}`;
        return result;
      }
      statusText = res.text;
    } catch (err) {
      if (err instanceof OakallowError && (err.status === 0 || err.status === 429 || err.status >= 500)) {
        io.warning(`Could not read approval status (${err.message}); will retry`);
      } else {
        result.message = explainError('Reading approval status failed', err);
        return result;
      }
    }

    if (statusText) {
      const status = statusText.match(STATUS_RE)?.[1];
      if (!status) {
        result.message = `Unexpected approval status reply from oakallow: ${statusText}`;
        return result;
      }
      if (TERMINAL.has(status)) {
        result.decision = status;
        result.decidedBy = statusText.match(DECIDED_BY_RE)?.[1]?.trim() || '';
        const by = result.decidedBy ? ` by ${result.decidedBy}` : '';
        if (status === 'approved') {
          result.ok = true;
          result.message = `${cfg.tool} approved${by} (${result.referenceId})`;
        } else {
          result.message = `${cfg.tool} approval ${status}${by} (${result.referenceId})`;
        }
        return result;
      }
    }

    if (now() >= deadline) {
      result.message = `No decision on ${cfg.tool} within ${cfg.maxWaitMinutes} minutes. ${result.referenceId} stays pending in oakallow until it expires.`;
      return result;
    }

    await sleepFn(cfg.pollSeconds * 1000);
  }
}

export function explainError(prefix, err) {
  if (!(err instanceof OakallowError)) return `${prefix}: ${err.message}`;
  const hints = {
    401: 'check that agent-token is a valid oakallow agent token',
    402: 'the org balance cannot cover this check',
    429: 'rate limited',
  };
  const hint = hints[err.status] ? ` (${hints[err.status]})` : '';
  return `${prefix}: ${err.message}${hint}`;
}

export function summaryMarkdown(cfg, r) {
  const rows = [
    ['Tool', `\`${cfg.tool}\``],
    cfg.resource && ['Resource', cfg.resource],
    cfg.method && ['Method', cfg.method],
    cfg.tenant && ['Tenant', cfg.tenant],
    ['Verdict', r.permission || 'none'],
    r.referenceId && ['Reference', r.referenceId],
    r.decision && ['Approval', r.decision],
    r.decidedBy && ['Decided by', r.decidedBy],
    ['Result', r.ok ? 'passed' : 'failed'],
  ].filter(Boolean);
  const table = rows.map(([k, v]) => `| ${k} | ${String(v).replace(/\|/g, '\\|')} |`).join('\n');
  return `### oakallow check\n\n| | |\n|---|---|\n${table}\n`;
}

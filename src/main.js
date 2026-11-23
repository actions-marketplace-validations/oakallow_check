import { getInput, log, mask, setOutput, appendSummary, setFailed } from './runner.js';
import { createClient } from './client.js';
import { parseConfig, githubContext, runGate, summaryMarkdown } from './gate.js';

async function main() {
  const agentToken = getInput('agent-token', { required: true });
  mask(agentToken);
  getInput('tool', { required: true });

  const cfg = parseConfig((name, fallback) => getInput(name, { fallback }));
  const gh = githubContext(process.env);
  const client = createClient({ apiUrl: cfg.apiUrl, agentToken });
  const io = { info: log.info, notice: log.notice, warning: log.warning };

  const r = await runGate({ cfg, gh, client, io });

  setOutput('permission', r.permission);
  setOutput('reference-id', r.referenceId);
  setOutput('decision', r.decision);
  setOutput('decided-by', r.decidedBy);
  appendSummary(summaryMarkdown(cfg, r));

  if (r.ok) log.info(`oakallow: ${r.message}`);
  else setFailed(`oakallow: ${r.message}`);
}

main().catch((err) => setFailed(`oakallow: ${err.message}`));

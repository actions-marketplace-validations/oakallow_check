# oakallow check

Gate any GitHub Actions step on [oakallow](https://oakallow.com). When your rules say a step needs a human, the job waits while an approver decides on their phone, in Slack, Discord or Teams, or in the dashboard. Every decision is recorded in your oakallow audit log with a signed receipt.

Use it before the steps you would not want to run unattended: production deploys, database migrations, data deletes, releases, or a step where an AI agent acts on your behalf.

```yaml
- uses: oakallow/check@v1
  with:
    agent-token: ${{ secrets.OAKALLOW_AGENT_TOKEN }}
    tool: deploy_production
```

## How it works

Your workflow runs as an oakallow **agent**. An agent belongs to exactly one org, can never approve anything, and appears by name in your audit log, so every run is traceable and the workflow cannot sign off on itself.

The action talks to oakallow's MCP server the same way any governed agent does:

1. It calls the governed tool you name, with a reason built from the run.
2. oakallow applies your rules:

| Verdict | What the step does |
|---|---|
| allowed | Passes at once. |
| requires approval | oakallow sends the request to your approvers. The step waits, then passes if approved and fails if denied, expired or cancelled. |
| disabled, blocked, lockdown, or a tool the org has not enabled | Fails, with oakallow's explanation in the log. |

Rules are set in the oakallow dashboard. Change a rule there and the next run follows it, with no workflow edit.

## Setup

1. In the [oakallow dashboard](https://oakallow.io), create an agent in the org this workflow should use, and copy its token.
2. Add the token to the repository or organization as a secret named `OAKALLOW_AGENT_TOKEN`.
3. Register the tool name you will check (for example `deploy_production`), enable it, and set its rule: allowed, requires approval, or disabled.
4. Add the step before the work it protects.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `agent-token` | yes | | oakallow agent token. Always pass it from a secret. |
| `tool` | yes | | Governed tool to check. Must be registered and enabled in the agent's org. |
| `resource` | no | | Resource the step acts on. Must be set up in oakallow, or the step fails. |
| `method` | no | | Method name. Must be set up in oakallow, or the step fails. |
| `tenant` | no | | Tenant external id. Must be set up in oakallow, or the step fails. |
| `reason` | no | repo, workflow, branch, commit, actor | What approvers see. |
| `wait-for-approval` | no | `true` | When `false`, the step fails as soon as approval is required. The request still reaches your approvers. |
| `poll-seconds` | no | `30` | Seconds between status checks while waiting. Minimum 10. |
| `max-wait-minutes` | no | `60` | Longest wait. |
| `api-url` | no | `https://api.oakallow.io` | API base URL. The action calls its `/mcp` endpoint. |

## Outputs

| Output | Description |
|---|---|
| `permission` | `allowed`, `requires_approval` or `disabled`. |
| `reference-id` | The approval reference (`REF-...`), or the signed decision receipt when the tool was allowed. |
| `decision` | `approved`, `denied`, `expired` or `cancelled`. |
| `decided-by` | The approver on record. |

The step also writes a short summary to the job page.

## Examples

### Approve production deploys

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    steps:
      - uses: actions/checkout@v4

      - name: Ask oakallow
        uses: oakallow/check@v1
        with:
          agent-token: ${{ secrets.OAKALLOW_AGENT_TOKEN }}
          tool: deploy_production

      - run: ./scripts/deploy.sh production
```

Give each environment its own rule either way:

- separate tools (`deploy_staging` allowed, `deploy_production` requires approval), or
- one tool plus `resource: production` / `resource: staging`, with a rule per resource.

A `resource`, `method` or `tenant` you send must be set up in oakallow. If it isn't, the step fails. It is never treated as allowed.

### Use the decision later in the job

```yaml
- id: gate
  uses: oakallow/check@v1
  with:
    agent-token: ${{ secrets.OAKALLOW_AGENT_TOKEN }}
    tool: publish_release

- run: echo "Approved by ${{ steps.gate.outputs.decided-by }} (${{ steps.gate.outputs.reference-id }})"
```

## One agent per environment (recommended)

The workflow says which resource it acts on, so lock that down:

1. In oakallow, create one agent per environment (for example `ci-staging`, `ci-production`) and, under **Targets**, lock each to its resource.
2. In GitHub, create the environments (Settings, Environments) and put each agent's token in that environment's secret, `OAKALLOW_AGENT_TOKEN`.
3. Give the job its environment:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: oakallow/check@v1
        with:
          agent-token: ${{ secrets.OAKALLOW_AGENT_TOKEN }}
          tool: deploy
          resource: production
```

A staging job never receives the production token, and the staging agent is refused for `production`. GitHub environments in private repositories need GitHub Pro, Team or Enterprise.

## Good to know

- **Cost.** Each run makes one billed check. Waiting for the decision is free.
- **Runner minutes.** Waiting keeps the runner busy, which uses Actions minutes on private repositories. Set `max-wait-minutes` and the job's `timeout-minutes` to match how long your approvers usually take.
- **One open request per agent, tool and target.** While a request is pending, a second run of the same agent and tool fails instead of waiting, so an approval only ever releases the run that asked for it. Deny or let the earlier request expire, then re-run. Use separate agents for workflows that can run at the same time.
- **Stopping early.** If the job is cancelled or stops waiting, the pending request stays open in oakallow until it expires, and blocks new runs of that agent and tool until then. Approving it afterwards does not run anything.
- **Fails closed.** Any reply the action does not recognize fails the step.

## Security

- **No dependencies.** Everything that runs is in `src/`, about 380 lines you can read.
- **One destination.** It only calls `api-url` (default `https://api.oakallow.io`) over HTTPS, and masks your agent token in logs.
- **Nothing else touched.** It does not read your code, files or other secrets, and installs nothing.

### Pin to a commit (recommended)

A tag like `@v1` can be moved to different code. A full commit SHA cannot. For the strongest guarantee, pin the exact commit you reviewed:

```yaml
- uses: oakallow/check@<full 40-character commit SHA>  # v1.0.0
```

Find the SHA on the release page. Dependabot can keep a pinned SHA up to date for you.

### Reporting

Report security issues to security@oakallow.io, not in a public issue.

## License

MIT. Copyright (c) 2026 Islemonics Studios LLC.

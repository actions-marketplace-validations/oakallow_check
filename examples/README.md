# Example workflows

| File | What it is |
|---|---|
| [`oakallow-test.yml`](oakallow-test.yml) | Try it first. A manual workflow with a scenario picker that shows each outcome: allowed, approved, denied, refused by an agent lock, refused for an unknown resource. |
| [`deploy.yml`](deploy.yml) | A real-shaped pipeline: staging deploys at once, production waits for approval. |

Copy a file into your repository's `.github/workflows/` folder. Both run only when you press **Run workflow**.

## Setup for both

### In oakallow (the org this workflow uses)

1. **Resources:** add `staging` and `production`.
2. **Tool:** add `deploy` and set its status to **Approved**. A tool in Draft refuses every call.
3. **Rules:** `deploy` on `staging` is **allowed**; `deploy` on `production` **requires approval**.
4. **Agents:** create `ci-staging` and `ci-production` and copy each token (it is shown once). Under **Targets**, lock `ci-staging` to `staging` and `ci-production` to `production`.
5. **Org, GitHub tab:** add both agents. Their runs then show under Recent runs.

### In GitHub

1. **Settings, Environments:** create `staging` and `production`.
2. In each environment, add the secret `OAKALLOW_AGENT_TOKEN` with that environment's agent token.

A staging job never receives the production token. Environments in private repositories need GitHub Pro, Team or Enterprise.

## Running oakallow-test.yml

Actions, **oakallow test**, **Run workflow**, then pick:

| Scenario | Expected |
|---|---|
| `staging` | Passes at once. |
| `production` | Waits. Approve and the deploy step runs. Run it again and deny: the job fails and the deploy never runs. |
| `wrong-resource` | Fails at once: the staging agent is locked to staging. No approval is sent. |
| `typo` | Fails at once: `prodution` is not set up in oakallow. No approval is sent. |

Each run's summary shows the decision, the reference number and who decided.

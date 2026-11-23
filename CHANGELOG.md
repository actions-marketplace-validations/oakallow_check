# Changelog

## 1.0.1

Documentation only. The action's code and behavior are unchanged.

- New `examples/` folder with ready-to-copy workflows:
  - `oakallow-test.yml`: a manual test with a scenario picker that shows every outcome (allowed, approved, denied, refused by an agent lock, refused for an unknown resource).
  - `deploy.yml`: a staging then production deploy where production waits for approval.
  - `examples/README.md`: the oakallow and GitHub setup both workflows need, and the expected result of each scenario.
- The README links to the examples.

## 1.0.0

First release.

- Runs as an oakallow agent over the MCP endpoint, using the same governed-tool flow as any agent.
- Allowed passes; approval required waits for the decision; anything else fails with oakallow's explanation.
- Outputs for the verdict, reference, decision and approver.
- Job summary.

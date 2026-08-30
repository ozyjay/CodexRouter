# Baseline evaluation harness

This harness compares a fixed single-model Codex turn with the same task run through fixed Explorer, Worker, and Reviewer roles. It also has a deterministic simulation backend for developing the harness without a Codex turn. It is an evaluation utility, not part of the VS Code extension's normal routing flow.

The manifest contains the evaluation prompts and therefore must be treated separately from Router telemetry. A case may include a local diff expectation: a relative file and required text patterns. It may also define a controlled mutation: the runner temporarily replaces one known source fragment, runs a validation command, and restores the original content. The runner records only whether that mutation was killed. Live reports contain only case IDs, model and effort allocations, durations, exit codes, whether a diff was produced, validation, expectation, and mutation status. Simulated reports deliberately omit allocations and declare that they do not attribute performance to any Codex model or role. The per-strategy summary reports each gate and combined verified counts, plus `averageVerifiedDurationMs` and `costPerVerifiedRunMs`; the latter charges unsuccessful runs to the strategy that incurred them. Reports never contain task text, source code, Codex output, App Server traffic, or credentials.

## Configure

Update `baseline-manifest.json` with representative cases and the model/effort combinations available from the live Codex App Server catalogue. Each validation command is an executable plus an argument array; shell strings, redirects, and pipelines are intentionally unsupported.

## Dry run

```bash
npm run eval:baseline
```

This validates the manifest and prints the planned cases. It does not start Codex, run validation commands, create worktrees, or write a report.

## Deterministic simulation

```bash
npm run eval:baseline:sim -- --iterations 3
```

Simulation uses the case's declared local patch instead of calling Codex, then runs the same worktree, validation, diff, mutation, and reporting gates. It creates temporary worktrees and a report but never starts the App Server or consumes ChatGPT allowance. Reports are labelled `executionBackend: "simulated"`; they validate the evaluation system only and must not be compared with, or used to make claims about, Codex models.

### ModelDeck simulation selector

To test whether a local selector chooses the declared deterministic simulation tiers, run:

```bash
npm run eval:baseline:sim -- \
  --selector modeldeck \
  --modeldeck-model codex-router-simulation-selector
```

The selector receives only the evaluation task and compact metadata. It selects `sim-small`, `sim-balanced`, or `sim-strong`; the harness then applies that case's declared deterministic patch for the selected tier and runs the ordinary gates. It records the public selector model ID, the live local Worker identity, latency, selected tier, and fallback status, but never the prompt, response, patch, or source code. A timeout, unavailable route, malformed response, or unknown tier uses deterministic `sim-balanced` and records only that fallback occurred.

`--selector modeldeck` performs local ModelDeck inference but does not start Codex or consume ChatGPT allowance. It is a selector-quality and harness test, not an evaluation of the local proxy models or Codex allocations.

## Live comparison

```bash
npm run eval:baseline -- --live
```

This explicitly consumes ChatGPT Codex allowance. Before starting a turn, it verifies ChatGPT authentication and validates every configured allocation against the live App Server catalogue. Each strategy starts in a fresh detached Git worktree at `HEAD`; fixed-role worktrees receive generated project-scoped custom-agent files. The runner uses Codex's documented `workspace-write` sandbox and retains ordinary approval and safety behaviour. After a Codex turn completes, it links the launch workspace's existing `node_modules` into the temporary worktree solely so the validation command can resolve the project's local tools. This link is not present while Codex works and is removed with the worktree. Codex output is discarded, then the manifest's validation command is run. If Codex cannot start, the report records only a bounded failure classification, never error text or generated output. The temporary worktree is removed afterwards. Live reports are labelled `executionBackend: "codex"`.

Use `--case focused-regression-test` to run a single case, `--iterations 3` for three matched trials per strategy, and `--ref <commit-or-branch>` to evaluate a specific committed revision. Reports are written to `evals/results/`, which is ignored by Git.

The current fixed-role workflow is deliberately sequential. The parent turn is asked to use Explorer, Worker, and Reviewer in that order. Parallel delegation is a separate variable and must not be compared with this baseline until it has its own evaluation arm.

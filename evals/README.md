# Baseline evaluation harness

This harness compares a fixed single-model Codex turn with the same task run through fixed Explorer, Worker, and Reviewer roles. It is an evaluation utility, not part of the VS Code extension's normal routing flow.

The manifest contains the evaluation prompts and therefore must be treated separately from Router telemetry. A case may include a local diff expectation: a relative file and required text patterns. It may also define a controlled mutation: the runner temporarily replaces one known source fragment, runs a validation command, and restores the original content. The runner records only whether that mutation was killed. Generated reports contain only case IDs, model and effort allocations, durations, exit codes, whether a diff was produced, validation, expectation, and mutation status. The per-strategy summary reports each gate and combined verified counts. Reports never contain task text, source code, Codex output, App Server traffic, or credentials.

## Configure

Update `baseline-manifest.json` with representative cases and the model/effort combinations available from the live Codex App Server catalogue. Each validation command is an executable plus an argument array; shell strings, redirects, and pipelines are intentionally unsupported.

## Dry run

```bash
npm run eval:baseline
```

This validates the manifest and prints the planned cases. It does not start Codex, run validation commands, create worktrees, or write a report.

## Live comparison

```bash
npm run eval:baseline -- --live
```

This explicitly consumes ChatGPT Codex allowance. Before starting a turn, it verifies ChatGPT authentication and validates every configured allocation against the live App Server catalogue. Each strategy starts in a fresh detached Git worktree at `HEAD`; fixed-role worktrees receive generated project-scoped custom-agent files. The runner uses Codex's documented `workspace-write` sandbox and retains ordinary approval and safety behaviour. After a Codex turn completes, it links the launch workspace's existing `node_modules` into the temporary worktree solely so the validation command can resolve the project's local tools. This link is not present while Codex works and is removed with the worktree. Codex output is discarded, then the manifest's validation command is run. If Codex cannot start, the report records only a bounded failure classification, never error text or generated output. The temporary worktree is removed afterwards.

Use `--case focused-regression-test` to run a single case, `--iterations 3` for three matched trials per strategy, and `--ref <commit-or-branch>` to evaluate a specific committed revision. Reports are written to `evals/results/`, which is ignored by Git.

The current fixed-role workflow is deliberately sequential. The parent turn is asked to use Explorer, Worker, and Reviewer in that order. Parallel delegation is a separate variable and must not be compared with this baseline until it has its own evaluation arm.

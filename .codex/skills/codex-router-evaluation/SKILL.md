---
name: codex-router-evaluation
description: Develop Codex Router evaluation manifests, simulation, local proxy cohorts, worktree handling, and privacy-safe reports.
---

# Codex Router evaluation work

Use this skill for `evals/`, `scripts/baseline-eval.ts`, and `src/evaluation.ts`.

- Treat manifests as sensitive evaluation input, not Router telemetry. Reports must retain only the documented privacy-safe IDs, outcomes, durations, and bounded failure categories.
- Prefer dry run or deterministic simulation while changing the harness. A live App Server run, local proxy invocation, or other allowance-consuming work requires explicit user opt-in.
- Keep trials isolated in detached temporary worktrees, validate before reporting success, and clean up transient resources even when a run fails.
- Keep simulated, local-proxy, and live-Codex results explicitly separated; never attribute a simulation result to a Codex model or role.
- For proxy cohorts, enforce declared context and writable-file limits, route identity stability, and fail-closed patch validation.

Run the relevant dry-run or simulation command, add focused tests where contracts change, then run `npm run check`.

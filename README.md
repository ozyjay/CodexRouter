# Codex Router

Codex Router is a local VS Code companion that recommends a Codex model and reasoning effort before submitting a task through the local Codex App Server. Its default is a transparent deterministic policy; an opt-in local ModelDeck classifier is available as an experimental policy.

It does not use the OpenAI Platform API, request an API key, or read `~/.codex/auth.json`. Codex App Server runs locally, but Codex model turns consume the user’s ChatGPT Codex allowance when authenticated through ChatGPT. This project does not require or use OpenAI Platform API credits in ChatGPT-only mode.

## What is implemented

- Dedicated **Codex Router** Activity Bar sidebar with task composer, context disclosure, recommendation approval/override, and streamed result.
- `@router` VS Code chat participant, when the host exposes the public Chat Participant API.
- `Codex Router: New Routed Task` command and selected-code context-menu fallback.
- One routing-session controller shared by commands and `@router`.
- Runtime model and reasoning-effort discovery through Codex App Server `model/list`.
- Safe authentication validation through App Server `account/read` without requesting tokens.
- Local ModelDeck discovery (`GET /v1/models`) and structured classification (`POST /v1/chat/completions`).
- Explicit selected-code ModelDeck proxy candidates with strict single-patch validation, preview, and optional Codex hand-off.
- Deterministic routing by default, strict local-classifier validation, and safety guardrails.
- Separate routing metadata and user-approved Codex execution context.
- Explicit **Use recommendation** or **Override** selection before any Codex turn begins.
- App Server stdio lifecycle handling, native approval prompts, streamed assistant output, and supported `turn/interrupt` cancellation.
- Optional, local-only privacy-preserving outcome records with Markdown export and deletion commands.

## Architecture and trust boundaries

```text
VS Code task / @router
        |
        v
deterministic policy (default) <---- safety baseline ---- optional ModelDeck policy
        |                                                   |
        +---------------- recommendation ------------------+
                                                            v
                                              explicit user approval or override
                                                            |
                                                            v
                                        Codex App Server over child-process stdio
                                                            |
                                                            v
                                            ChatGPT-authenticated Codex turn
```

The router normally receives only the task. Active-file language and relative-name metadata are opt-in. The selected-code command supplies only selection metadata to routing; the source excerpt is withheld from the classifier and included in the Codex execution prompt after the user accepts or overrides the recommendation. No repository-wide content is sent by default.

The separate **Generate ModelDeck Proxy Candidate for Selection** command is more explicit because a coding proxy needs source context. It shows the filename, selected-character count, and configured ModelDeck model before sending the task and selection to the loopback endpoint. It accepts exactly one patch for that file, requires the search text to occur exactly once in the selection, and opens an advisory preview without changing the workspace. The user may then route that candidate through Codex; Codex reviews it independently through the normal recommendation, approval, sandbox, and verification flow.

Router analytics never store task text, source code, selected excerpts, filenames, workspace names, generated answers, App Server protocol messages, or credentials.

The extension spawns `codex app-server --stdio`; it does not expose a listening service. ModelDeck URLs are rejected unless their host is the literal loopback address `127.0.0.1` or `::1`.

## Prerequisites

- VS Code 1.135 or later.
- Node.js 22 or later for development.
- Codex CLI installed and authenticated with ChatGPT:

  ```powershell
  codex login status
  ```

  If this does not show ChatGPT authentication, run:

  ```powershell
  codex logout
  codex login
  codex login status
  ```

- Optional: ModelDeck running on its configured loopback endpoint. The default is `http://127.0.0.1:8600/v1`.

## Install and run in VS Code

```powershell
npm install
npm run compile
```

Open this folder in VS Code and press `F5` to start an Extension Development Host. In that window:

1. Select the **Codex Router** compass icon in the Activity Bar, enter a task, and choose **Get recommendation**. Alternatively, run **Codex Router: New Routed Task**, or type `@router` in VS Code Chat.
2. Enter a task.
3. Review the recommended model, effort, recommendation strength, source, limited-context summary, and rationale.
4. Select **Use recommendation** or **Override**.
5. Approve Codex actions through its normal approval and sandbox flow.

While a turn is running, select the Codex Router status item or run **Codex Router: Cancel Active Turn** to request App Server `turn/interrupt`.

Use **Codex Router: Send Selection to Codex Router** from an editor selection to send only selection metadata to routing and make the excerpt available to the executing Codex turn after approval.

To use a ModelDeck coding route as an adviser, select up to 12,000 characters and run **Codex Router: Generate ModelDeck Proxy Candidate for Selection**. Confirm the limited context disclosure, review the candidate preview, then optionally choose **Route candidate through Codex**. Dismissing the action leaves the workspace unchanged and does not start a Codex turn.

### Debugging

The repository includes a **Run Codex Router** launch configuration. Open `src/extension.ts`, set a breakpoint, and press `F5`. VS Code first runs `npm run compile`, then opens an Extension Development Host with this extension loaded. Trigger **Codex Router: New Routed Task** in that development window to stop at the breakpoint. Use the **npm: watch** task while actively editing to rebuild on save.

If something does not start, run **Codex Router: Show Diagnostics** from the Command Palette in the Extension Development Host. It opens the `Codex Router` output channel and records activation, Chat participant registration, App Server status, and safe error messages. `@router` requires that this VS Code host exposes the public Chat Participant API; the command entry point does not.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `codexRouter.routing.provider` | `deterministic` | Selects the transparent baseline or the opt-in `modeldeck-experimental` policy. |
| `codexRouter.modelDeck.baseUrl` | `http://127.0.0.1:8600/v1` | Local ModelDeck OpenAI-compatible endpoint. |
| `codexRouter.modelDeck.routerModel` | empty | Optional local routing model ID. Empty chooses the first ready model advertised by ModelDeck. |
| `codexRouter.modelDeck.proxyModel` | `codex-router-proxy-balanced` | ModelDeck coding route used only after the selected-code proxy command and disclosure confirmation. |
| `codexRouter.modelDeck.proxyTimeoutMs` | `120000` | Timeout for an explicitly requested local proxy candidate. |
| `codexRouter.modelDeck.proxyMaxTokens` | `2048` | Maximum local proxy-candidate output budget. |
| `codexRouter.requestTimeoutMs` | `5000` | Experimental local-classifier timeout. |
| `codexRouter.analytics.enabled` | `false` | Enables local outcome records. |

ModelDeck classification is not contacted under the default policy. The proxy command contacts ModelDeck only after its separate disclosure confirmation, regardless of the routing-provider setting. An unavailable, timed-out, malformed, non-loopback, out-of-scope, or inapplicable proxy result fails closed; it is never applied and never replaced with a generated fallback. An experimental classifier failure instead falls back visibly to the deterministic policy without a cloud-routing request.

## Routing policy

The deterministic policy assesses scope, ambiguity, exploration, architectural judgement, reversibility, blast radius, verification burden, consequential risk, and whether work is bounded and repeatable. Recommendations use ordinal `weak`, `moderate`, or `strong` strength; these labels describe policy clarity, not a calibrated probability.

The deterministic policy starts with:

- Luna / low for narrow, explicit, repeatable work.
- Terra / medium for ordinary implementation, tests, documentation, and debugging.
- Sol / high for security-sensitive, destructive, migration, concurrent/distributed, ambiguous, or broad architectural work.

Every result is mapped to the live App Server catalogue. Missing tiers prefer the nearest stronger recognised tier before a weaker tier; unsupported efforts prefer the nearest stronger recognised effort. Unrecognised catalogues use the advertised default. Every substitution is disclosed. Safety guardrails take precedence over experimental local-model advice.

A user can override every recommendation using only live, visible model/effort combinations. The router changes allocation only before a new turn starts.

## Privacy and local records

When `codexRouter.analytics.enabled` is enabled, versioned `outcomes.ndjson` records are stored beneath VS Code’s extension global storage. Turn state is separate from user-reported task completion and build/test evidence: a completed Codex turn is not automatically a successful software task.

Run **Codex Router: Export Outcome Report** to choose a Markdown destination. Reports show sample size, missing outcomes, overrides, verified completion, repair turns, elapsed time per verified completion, user-reported under- or over-routing, and whether a named local proxy advisory was included. Records store only that proxy public model ID—not its task, file, search text, replacement, source context, or output. Groups with fewer than 20 observed outcomes or five verified completions are marked too small for a policy change. Run **Codex Router: Clear Local Outcome Records** to delete the local store after confirmation.

Codex Local Meter remains the preferred source for observing ChatGPT Codex usage. Codex Router does not read or depend on another extension’s private state.

## Development and verification

Use PowerShell as the primary project shell. Package tasks invoke `pwsh -NoProfile` through `scripts/invoke.ps1`.

```powershell
npm run compile
npm run test
npm run check
```

The test suite uses fake App Server and ModelDeck transports; it makes no Codex model turns and consumes no ChatGPT allowance.

### Fixed-role baseline evaluation

`npm run eval:baseline` performs a no-side-effect dry run of the fixed single-model versus Explorer/Worker/Reviewer evaluation manifest. Use `npm run eval:baseline:sim` for a deterministic, no-allowance worktree evaluation that tests the harness only. A live run requires an explicit `--live` flag, validates every allocation against the live App Server catalogue, uses detached temporary worktrees, and consumes ChatGPT Codex allowance. Use `--iterations 3` for matched repeated trials. See [the baseline evaluation guide](evals/README.md) for configuration and safeguards.

To test the optional local ModelDeck simulation selector without a Codex turn, use `npm run eval:baseline:sim -- --selector modeldeck --modeldeck-model codex-router-simulation-selector`. The selector only chooses a declared deterministic tier; malformed, unavailable, or timed-out selector responses visibly fall back to `sim-balanced`.

The simulation summary also records the match rate for manifest cases with an explicit expected simulation tier. This measures selector calibration only; it does not attribute quality or performance to a Codex or local proxy model.

For a constrained local proxy-candidate run, use `npm run eval:baseline -- --slm-proxy --selector modeldeck --modeldeck-model codex-router-simulation-selector --case focused-regression-test`. Each case iteration runs exactly one `proxy-candidate` strategy; it is not a single-model versus fixed-role comparison. The manifest must explicitly limit both context and writable files; malformed, out-of-scope, or inapplicable candidates fail without deterministic fallback. Results are labelled `slm-proxy` and are evidence about the configured local proxies only, never Codex allocations or performance.

### Opt-in manual smoke test

This starts a real Codex turn and consumes the user’s ChatGPT Codex allowance:

1. Confirm `codex login status` reports ChatGPT authentication.
2. Start an Extension Development Host with `F5`.
3. Run **Codex Router: New Routed Task** with a harmless task such as “Add a comment to the README and report the change”.
4. Confirm deterministic routing is shown, select a configuration, and verify streamed output, ordinary Codex approvals, and cancellation with a harmless long-running task if appropriate.
5. Optionally enable `modeldeck-experimental` and confirm its identity or visible deterministic fallback.
6. Optionally select a harmless unique excerpt, run **Generate ModelDeck Proxy Candidate for Selection**, confirm the disclosed context, and verify that dismissing the preview action makes no edit and starts no Codex turn. Routing it onwards consumes ChatGPT Codex allowance.
7. Confirm the status item reports the selected model and effort. If analytics was enabled, inspect only the metadata record and exported report.

## Current limitations and next steps

- The installed `codex-cli 0.150.1` schema was inspected for `account/read`, `model/list`, `turn/start`, `turn/interrupt`, terminal turn states, and approval requests. Real Codex execution and the configured ModelDeck proxy route still require the explicit manual smoke test above because they depend on local runtime state; a routed Codex turn consumes ChatGPT allowance.
- The sidebar, commands, and `@router` share the same routing-session controller. The sidebar supports task-only routing and optional active-file metadata; selected-code and ModelDeck proxy flows remain available from their commands.
- Build/test outcomes and repair-turn counts are deliberately user-reported rather than inferred from model output.
- The `@router` entry point depends on the host enabling VS Code’s public Chat Participant API. The command entry point is always available.

Future work should add representative matched live evaluations. Automatic adaptation remains research-only until reproducible evidence supports it.

For the proposed independent-extension UX, production architecture, staged delivery plan, and non-goals, see [Production direction](docs/PRODUCTION_DIRECTION.md). For the phase-aware orchestration baseline and adaptive-routing evaluation design, see [Adaptive orchestration proposal](docs/ADAPTIVE_ORCHESTRATION_PROPOSAL.md).

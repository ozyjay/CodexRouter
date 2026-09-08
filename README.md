# Codex Router

Codex Router is a local VS Code companion that recommends a Codex model and reasoning effort before submitting a task through the local Codex App Server. Its default is a transparent deterministic policy; an opt-in local ModelDeck classifier is available as an experimental policy.

It does not use the OpenAI Platform API, request an API key, or read `~/.codex/auth.json`. Codex App Server runs locally, but Codex model turns consume the user’s ChatGPT Codex allowance when authenticated through ChatGPT. This project does not require or use OpenAI Platform API credits in ChatGPT-only mode.

## What is implemented

- Dedicated **Codex Router** Activity Bar conversation with task composer, context disclosure, recommendation approval/override, and streamed result.
- `Codex Router: New Routed Task` command and selected-code context-menu fallback.
- One routing-session controller shared by the sidebar and commands.
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
VS Code sidebar / command
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

1. Select the **Codex Router** compass icon in the Activity Bar, enter a task, and choose **Get recommendation**. Alternatively, run **Codex Router: New Routed Task**.
2. Enter a task.
3. Review the recommended model, effort, recommendation strength, source, limited-context summary, and rationale.
4. Select **Use recommendation** or **Override**.
5. Approve Codex actions through its normal approval and sandbox flow.

While a turn is running, select the Codex Router status item or run **Codex Router: Cancel Active Turn** to request App Server `turn/interrupt`.

Use **Codex Router: Send Selection to Codex Router** from an editor selection to send only selection metadata to routing and make the excerpt available to the executing Codex turn after approval.

To use a ModelDeck coding route as an adviser, select up to 12,000 characters and run **Codex Router: Generate ModelDeck Proxy Candidate for Selection**. Confirm the limited context disclosure, review the candidate preview, then optionally choose **Route candidate through Codex**. Dismissing the action leaves the workspace unchanged and does not start a Codex turn.

### Package and install locally

From the repository root, create an installable VSIX:

```powershell
npm ci
npm run package-install
```

`npm run package-install` is the local full flow: it compiles, increments `package.json`, packages the extension, then installs the resulting `.vsix` into the current VS Code host.

By default, it increments the patch version (for example, `0.1.0` -> `0.1.1`).

To bump a different part before packaging/installing:

```powershell
npm run package-install -- --bump minor
npm run package-install -- --bump major
```

To choose a different output filename, pass `--out`:

```powershell
npm run package-install -- --out ./codex-router-local.vsix --bump minor
```

The equivalent direct PowerShell command is `pwsh -NoProfile -File scripts/invoke.ps1 package-install --bump minor`.

`npm run package` still performs a package-only build for when you only want a VSIX artifact. It compiles the extension, then uses the project's local `@vscode/vsce` dependency to create `codex-router-<version>.vsix` in the repository root. The version comes from `package.json`. To choose a different filename, run `npm run package -- --out ./codex-router-local.vsix`. The equivalent direct PowerShell command is `pwsh -NoProfile -File scripts/invoke.ps1 package`.

Alternatively, run **Extensions: Install from VSIX...** in VS Code and select the generated file. Reload VS Code if prompted. Installation requires VS Code 1.135 or later.

The package uses `codex-router-local` as its local publisher identifier. Packaging does not publish anything or require a Marketplace account. It includes only compiled JavaScript, the Activity Bar icon, the manifest and this README; local settings, source maps, tests, evaluation results and development logs are excluded. Missing repository and licence metadata are allowed for local packaging; review those before any future Marketplace release.

### Debugging

The repository includes a **Run Codex Router** launch configuration. Open `src/extension.ts`, set a breakpoint, and press `F5`. VS Code first runs `npm run compile`, then opens an Extension Development Host with this extension loaded. Trigger **Codex Router: New Routed Task** in that development window to stop at the breakpoint. Use the **npm: watch** task while actively editing to rebuild on save.

If something does not start, run **Codex Router: Show Diagnostics** from the Command Palette in the Extension Development Host. It opens the `Codex Router` output channel and records activation, App Server status, and safe error messages.

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
| `codexRouter.diagnostics.developmentLogs` | `false` | Retains sensitive sidebar and command-task development logs under the extension log directory. Enabled in this repository's workspace settings for development. |
| `codexRouter.diagnostics.logRawClassifierResponses` | `false` | Debug only: writes rejected local-classifier responses to the local Codex Router output channel. Responses may contain sensitive task content. |
| `codexRouter.analytics.enabled` | `false` | Enables local outcome records. |

The sidebar keeps the conversation in a scrollable area above a bottom-anchored composer. Its in-memory transcript is restored when the sidebar view is recreated during the current extension session. Enter or the arrow button requests a recommendation; Shift+Enter inserts a new line. The composer grows with your task up to a bounded height. Open **Context** to include active-file metadata or read the conversation help. Recommendations require **Start Codex**; expand **Override model or effort** to choose another advertised configuration.

The composer’s **Recommendation source** selector controls the same `codexRouter.routing.provider` preference. **Deterministic policy** is the default. **Local SLM** sends only the documented compact routing input to the configured loopback ModelDeck endpoint; Codex still executes the approved task in both modes. The Local SLM is experimental: an unavailable, malformed, or unsafe result visibly falls back to the deterministic policy.

Use **Stop model** in the bottom composer to interrupt the active turn, including while it is starting. It replaces the recommendation arrow during execution. **Stopping…** remains visible until Codex confirms the turn has ended; a failed stop request offers a retry. Stopping does not undo edits already made. The command palette also provides **Codex Router: Cancel Active Turn**.

The sidebar shows a **Live activity** feed for each running turn: commands, tool calls, file paths changed, reasoning summaries when supplied, and approval waits. Entries with useful details or command output can be expanded; entries without details remain compact summary rows. Entries show elapsed time and completion status; a timer reports time since the last activity or assistant-text event without assuming that a quiet turn is stuck. Output is limited to 16,384 characters per entry and 100 entries per turn; partial output lines are held until complete (or the item ends) for credential filtering. Reasoning summaries are optional and are not a continuous view of internal thinking. Activity details remain in panel memory, are cleared with **New conversation** or closing the view, and are not added to diagnostic logs or outcome records. Filtering is best effort; details can still contain sensitive source content.

During a streamed Codex response, the sidebar displays an estimated `tok/s` rate. It is calculated locally from generated-text length and elapsed streaming time; it is not an App Server usage measurement.

ModelDeck classification is not contacted under the default policy. The proxy command contacts ModelDeck only after its separate disclosure confirmation, regardless of the routing-provider setting. An unavailable, timed-out, malformed, non-loopback, out-of-scope, or inapplicable proxy result fails closed; it is never applied and never replaced with a generated fallback. An experimental classifier failure instead falls back visibly to the deterministic policy without a cloud-routing request. For classifier failures, the Codex Router output channel records a privacy-safe rejection category (for example, JSON parsing or contract validation). To inspect the full rejected response during local debugging, explicitly enable `codexRouter.diagnostics.logRawClassifierResponses`; it is disabled by default because the response may contain sensitive task content.

### Sidebar development logs

Set `codexRouter.diagnostics.developmentLogs` to `true` to record the next sidebar or command-palette task. This repository's `.vscode/settings.json` enables it for current development. After rebuilding, restart the Extension Development Host so it loads the new code, with this workspace open. The **Codex Router** Output channel prints the exact file path at the start of each session: `<extension log directory>/debug/run-*/events.jsonl`. The extension log directory is provided by VS Code and can change between host sessions.

The file records task input, classifier requests and responses (including unsupported allocations), the live catalogue, recommendations, approval or override, the execution prompt, displayed output, and final state. Ordinary Output diagnostics contain operational metadata only. Detailed files contain sensitive task/source/model content and use best-effort credential redaction and owner-only file permissions on POSIX. They exclude HTTP headers, authentication files, environment dumps, and raw App Server traffic; they do not capture a complete transcript of Codex tool execution. Logging failures are reported without stopping the task.

These logs are separate from evaluation CLI logs and opt-in outcome records. They are never automatically exported. Delete the relevant `run-*` directory after debugging and set the preference to `false` to stop future capture; VS Code may also clean up its log directories. For another workspace, explicitly enable the preference there. If `unsupported-allocation` recurs, inspect `routing.allocation-rejected` for `model-not-advertised`, `model-hidden`, or `effort-not-supported`, then compare the rejected pair with `catalogue.received` and the detailed `classifier.response` event. The original discarded response cannot be recovered.

## Routing policy

Sidebar follow-ups reuse the same Codex App Server thread, so requests such as “write this as a proposal” retain the preceding discussion. Each turn still requires approval of its model and effort. **New conversation** clears the displayed history and starts a fresh thread on the next approved turn; it is disabled while a task is active or awaiting approval. Closing and reopening the view restores the current in-memory transcript and thread; restarting the extension resets them. A changed workspace or restarted App Server requires an explicit new conversation rather than silently losing context. Standalone command tasks remain independent. The classifier receives only the current routing input and catalogue, not previous Codex messages or source; the context preview discloses when Codex will also use prior turns.

The experimental classifier receives the live App Server catalogue as compact `availableModels` metadata: visible model IDs, their supported efforts, and advertised defaults. It must select an exact supported pair. Unknown models, hidden models, and unsupported efforts still trigger deterministic fallback. The Output channel identifies the rejected pair and the specific rejection reason; it also records the available choices, accepted configuration, and final session state. A supported model is preserved even when its name is outside the familiar Luna/Terra/Sol tiers, unless the existing safety guardrails require escalation. This policy is recorded as `modeldeck-experimental-v3+deterministic-v1-guardrails`.

The request includes a machine-readable `responseSchema` in the prompt, backed by the same field rules used for local validation. This does not assume the local inference backend supports constrained JSON decoding. Risk describes potential harm from execution, separately from creative complexity and ambiguity: brainstorming and documentation normally have `normal` risk. The observed legacy value `risk: "low"` is explicitly normalised to `normal`; all other unknown values remain invalid. Validation failures name the offending fields without logging their contents. Escalation signals should describe observed facts, and creativity alone should not justify maximum effort. These instructions improve classification guidance but require live calibration; valid JSON alone cannot prove a recommendation is appropriate.

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

### Project skills

Codex Router development skills live in [`.codex/skills`](.codex/skills). They are eligible only in this workspace; when the installed Codex version does not discover workspace skills automatically, this repository's `AGENTS.md` routes matching work to the relevant skill. They are never installed into the global Codex skills directory.

```powershell
npm run compile
npm run test
npm run check
```

The test suite uses fake App Server and ModelDeck transports; it makes no Codex model turns and consumes no ChatGPT allowance.

### Fixed-role baseline evaluation

`npm run eval:baseline` performs a no-side-effect dry run of the fixed single-model versus Explorer/Worker/Reviewer evaluation manifest. Use `npm run eval:baseline:sim` for a deterministic, no-allowance worktree evaluation that tests the harness only. A live run requires an explicit `--live` flag, validates every allocation against the live App Server catalogue, uses detached temporary worktrees, and consumes ChatGPT Codex allowance. Use `--iterations 3` for matched repeated trials. See [the baseline evaluation guide](evals/README.md) for configuration and safeguards.

For development, add `--debug-logs` to an evaluation command to retain timestamped process output, tracked-file diffs, ModelDeck request/response bodies, and gate diagnostics in `evals/results/debug/run-*/events.jsonl`. These opt-in logs contain sensitive task/source/model content, with best-effort credential redaction; they are separate from ordinary reports, ignored by Git at the default location, and retained until manually deleted. See [development logging details](evals/README.md#development-logs). This flag does not enable extension logging or start a live run by itself.

To test the optional local ModelDeck simulation selector without a Codex turn, use `npm run eval:baseline:sim -- --selector modeldeck --modeldeck-model codex-router-simulation-selector`. The selector only chooses a declared deterministic tier; malformed, unavailable, or timed-out selector responses visibly fall back to `sim-balanced`.

The simulation summary also records the match rate for manifest cases with an explicit expected simulation tier. This measures selector calibration only; it does not attribute quality or performance to a Codex or local proxy model.

For a constrained local proxy-candidate run, use `npm run eval:baseline -- --slm-proxy --selector modeldeck --modeldeck-model codex-router-simulation-selector --case focused-regression-test`. Each case iteration runs exactly one `proxy-candidate` strategy; it is not a single-model versus fixed-role comparison. The manifest must explicitly limit both context and writable files; malformed, out-of-scope, or inapplicable candidates fail without deterministic fallback. Results are labelled `slm-proxy` and are evidence about the configured local proxies only, never Codex allocations or performance.

### Opt-in manual smoke test

This starts a real Codex turn and consumes the user’s ChatGPT Codex allowance:

1. Confirm `codex login status` reports ChatGPT authentication.
2. Start an Extension Development Host with `F5`.
3. Run **Codex Router: New Routed Task** with a harmless task such as “Add a comment to the README and report the change”.
4. Expand live activity entries during a task that runs a command and edits a file. Check streamed output, completion/exit status, quiet-period timing, keyboard operation of the expanders, and light/dark themes. Check that cancellation or a failed turn stops the timer, and a follow-up has a separate activity feed.
5. Confirm deterministic routing is shown, select a configuration, and verify streamed output, ordinary Codex approvals, and cancellation with a harmless long-running task if appropriate.
6. Optionally enable `modeldeck-experimental` and confirm its identity or visible deterministic fallback.
7. Optionally select a harmless unique excerpt, run **Generate ModelDeck Proxy Candidate for Selection**, confirm the disclosed context, and verify that dismissing the preview action makes no edit and starts no Codex turn. Routing it onwards consumes ChatGPT Codex allowance.
8. Confirm the status item reports the selected model and effort. If analytics was enabled, inspect only the metadata record and exported report.
9. In the sidebar, request a game concept, then ask “write this as a proposal”. Confirm the second turn uses that concept, including after changing model/effort. Choose **New conversation** and confirm the next task is independent. Development logs identify follow-ups with `conversation.context` and `continued: true`.

## Current limitations and next steps

- The installed `codex-cli 0.150.1` schema was inspected for `account/read`, `model/list`, `turn/start`, `turn/interrupt`, terminal turn states, and approval requests. Real Codex execution and the configured ModelDeck proxy route still require the explicit manual smoke test above because they depend on local runtime state; a routed Codex turn consumes ChatGPT allowance.
- The sidebar and commands share the same routing-session controller. The sidebar supports task-only routing and optional active-file metadata; selected-code and ModelDeck proxy flows remain available from their commands.
- Build/test outcomes and repair-turn counts are deliberately user-reported rather than inferred from model output.

Future work should add representative matched live evaluations. Automatic adaptation remains research-only until reproducible evidence supports it.

For the proposed independent-extension UX, production architecture, staged delivery plan, and non-goals, see [Production direction](docs/PRODUCTION_DIRECTION.md). For the phase-aware orchestration baseline and adaptive-routing evaluation design, see [Adaptive orchestration proposal](docs/ADAPTIVE_ORCHESTRATION_PROPOSAL.md).

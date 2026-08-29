# Codex Router

Codex Router is a local VS Code companion that recommends a Codex model and reasoning effort before submitting a task through the local Codex App Server. It is a proof of concept for adaptive task routing using ChatGPT-authenticated Codex and a local ModelDeck classifier.

It does not use the OpenAI Platform API, request an API key, or read `~/.codex/auth.json`. Codex App Server runs locally, but Codex model turns consume the user’s ChatGPT Codex allowance when authenticated through ChatGPT. This project does not require or use OpenAI Platform API credits in ChatGPT-only mode.

## What is implemented

- `@router` VS Code chat participant, when the host exposes the public Chat Participant API.
- `Codex Router: New Routed Task` command and selected-code context-menu fallback.
- Runtime model and reasoning-effort discovery through Codex App Server `model/list`.
- Safe authentication validation through `getAuthStatus` with `includeToken: false`.
- Local ModelDeck discovery (`GET /v1/models`) and structured classification (`POST /v1/chat/completions`).
- Strict local validation, deterministic fallback, and security/scope guardrails.
- Explicit **Use recommendation** or **Override** selection before any Codex turn begins.
- App Server stdio lifecycle handling and streamed assistant-message output.
- Optional, local-only privacy-preserving outcome records.

## Architecture and trust boundaries

```text
VS Code task / @router
        |
        v
local ModelDeck classifier ---- unavailable/malformed ----> deterministic guardrails
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

Only the task, explicitly selected file information, language identifier, and compact workspace metadata are supplied to the local router. No repository-wide content is sent by default. Router analytics never store task text, source code, generated answers, App Server protocol messages, or credentials.

The extension spawns `codex app-server --stdio`; it does not expose a listening service. ModelDeck URLs are rejected unless their host is the literal loopback address `127.0.0.1` or `::1`.

## Prerequisites

- VS Code 1.135 or later.
- Node.js 22 or later for development.
- Codex CLI installed and authenticated with ChatGPT:

  ```bash
  codex login status
  ```

  If this does not show ChatGPT authentication, run:

  ```bash
  codex logout
  codex login
  codex login status
  ```

- Optional: ModelDeck running on its configured loopback endpoint. The default is `http://127.0.0.1:8600/v1`.

## Install and run in VS Code

```bash
npm install
npm run compile
```

Open this folder in VS Code and press `F5` to start an Extension Development Host. In that window:

1. Run **Codex Router: New Routed Task**, or type `@router` in VS Code Chat.
2. Enter a task.
3. Review the recommended model, effort, confidence, and rationale.
4. Select **Use recommendation** or **Override**.
5. Approve Codex actions through its normal approval and sandbox flow.

Use **Codex Router: Send Selection to Codex Router** from an editor selection to make that selected excerpt available to the local classifier and submitted task.

### Debugging

The repository includes a **Run Codex Router** launch configuration. Open `src/extension.ts`, set a breakpoint, and press `F5`. VS Code first runs `npm run compile`, then opens an Extension Development Host with this extension loaded. Trigger **Codex Router: New Routed Task** in that development window to stop at the breakpoint. Use the **npm: watch** task while actively editing to rebuild on save.

If something does not start, run **Codex Router: Show Diagnostics** from the Command Palette in the Extension Development Host. It opens the `Codex Router` output channel and records activation, Chat participant registration, App Server status, and safe error messages. `@router` requires that this VS Code host exposes the public Chat Participant API; the command entry point does not.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `codexRouter.modelDeck.baseUrl` | `http://127.0.0.1:8600/v1` | Local ModelDeck OpenAI-compatible endpoint. |
| `codexRouter.modelDeck.routerModel` | empty | Optional local routing model ID. Empty chooses the first ready model advertised by ModelDeck. |
| `codexRouter.requestTimeoutMs` | `15000` | Local router timeout. |
| `codexRouter.analytics.enabled` | `false` | Enables local outcome records. |

If ModelDeck cannot be reached, returns malformed JSON, has no ready model, or is configured with a non-loopback URL, Codex Router labels the decision internally as deterministic fallback and does not contact a cloud routing model.

## Routing policy

The local classifier proposes a JSON recommendation. Codex Router validates that recommendation against the live App Server catalogue, including each model’s supported reasoning efforts. The classifier cannot choose unsupported models or efforts.

The deterministic policy starts with:

- Luna / low for narrow, explicit, repeatable work.
- Terra / medium for ordinary implementation, tests, documentation, and debugging.
- Sol / high for security-sensitive, destructive, migration, concurrent/distributed, ambiguous, or broad architectural work.

Guardrails take precedence over local-model advice. A user can override every recommendation. The router only changes model or effort when starting a new turn; it does not interrupt an active turn to change settings.

## Privacy and local records

When `codexRouter.analytics.enabled` is enabled, `outcomes.ndjson` is stored beneath VS Code’s extension global storage. Each record has an anonymous, one-way workspace identifier plus routing metadata such as selected model/effort, duration, completion state, and optional later validation state. It deliberately excludes task text, paths, source code, model output, and credentials.

Codex Local Meter remains the preferred source for observing ChatGPT Codex usage. Codex Router does not read or depend on another extension’s private state.

## Development and verification

```bash
npm run compile
npm run test
npm run check
```

The test suite uses fake App Server and ModelDeck transports; it makes no Codex model turns and consumes no ChatGPT allowance.

### Opt-in manual smoke test

This starts a real Codex turn and consumes the user’s ChatGPT Codex allowance:

1. Confirm `codex login status` reports ChatGPT authentication.
2. Start an Extension Development Host with `F5`.
3. Run **Codex Router: New Routed Task** with a harmless task such as “Add a comment to the README and report the change”.
4. Confirm ModelDeck routing or deterministic fallback is shown, select a configuration, and verify streamed output and ordinary Codex approvals.
5. Confirm the status item reports the selected model and effort. If analytics was enabled, inspect only the metadata record in VS Code global storage.

## Current limitations and next steps

- Real App Server and ModelDeck smoke testing must be performed outside this build sandbox; the sandbox cannot open the local ModelDeck socket or initialise Codex’s writable runtime state.
- The initial evaluation store supports router-versus-fixed strategy exports conceptually but does not yet ship a visual evaluation report.
- Validation/test outcomes and repair-turn counts are designed into the record contract, but are not yet automatically inferred from Codex output.
- The `@router` entry point depends on the host enabling VS Code’s public Chat Participant API. The command entry point is always available.

Future work should add an evaluation view/export, user success ratings, observed build/test results, and an opt-in contextual-bandit policy trained only from the local metadata contract.

For the proposed independent-extension UX, production architecture, staged delivery plan, and non-goals, see [Production direction](docs/PRODUCTION_DIRECTION.md). For the phase-aware orchestration baseline and adaptive-routing evaluation design, see [Adaptive orchestration proposal](docs/ADAPTIVE_ORCHESTRATION_PROPOSAL.md).

# Codex Router: production direction

## Decision

Build Codex Router as an independent VS Code extension with its own focused router workspace. Do not attempt to inject `@router` into the existing Codex extension. The Codex extension is a separate product surface; it does not expose a supported public composer-interception API. VS Code Chat participation remains an optional secondary entry point, not the primary product.

The production experience should make routing intentional and inspectable before a Codex turn begins, while leaving the established Codex extension free to handle ordinary direct conversations.

## Product position

Codex Router is not another general coding agent. It is a local decision layer and launchpad for Codex:

```text
Describe task → route locally → review recommendation → approve/override → run Codex → observe outcome
```

Its value is transparent model/effort selection, safe handling of consequential work, and evidence for whether adaptive routing improves outcomes. It should not duplicate broad file editing, Git, terminal, approvals, or agent-history interfaces that Codex already provides.

The next-level research direction is documented separately in [Adaptive orchestration and evaluation proposal](ADAPTIVE_ORCHESTRATION_PROPOSAL.md). That proposal requires a fixed Codex-native role baseline before phase-aware or subagent routing is treated as valuable.

## Primary UX

Create one **Codex Router** view in the VS Code secondary sidebar. It should be narrow enough to sit beside the editor and usable without VS Code Chat or the Codex extension being open.

### Router panel states

| State | Content | Main action |
| --- | --- | --- |
| Ready | Task composer, active file/selection toggles, service health summary | Analyse task |
| Recommendation | Model, effort, confidence, concise reasons, source, escalation signals | Use recommendation / Override |
| Running | Selected model and effort, Codex progress, streamed response, normal approval status | Open output / Cancel if supported |
| Completed | Final response summary, elapsed time, optional validation/rating capture | New routed task |
| Recovery | Clear problem and safe recovery instructions | Recheck App Server / Open settings |

The composer should include task text plus opt-in chips for the active file, selection, language, and diagnostics. Show exactly what will be sent to the local router before analysis. Do not add a “send entire workspace” control.

### Recommendation card

The recommendation card is the centre of the product. It must show:

- selected Codex model and effort;
- confidence and whether the result came from ModelDeck or deterministic fallback;
- no more than three concise reasons;
- relevant escalation signals;
- a model/effort override that is constrained to App Server-discovered choices;
- a small warning for guardrail escalation, for example “Security-sensitive task: Sol/high selected”.

Selecting **Use recommendation** starts a new App Server thread. Selecting **Override** opens native VS Code Quick Picks initially; the production panel may later render the same constrained controls directly.

### Secondary entry points

- **Codex Router: New Routed Task** is the universal keyboard/command-palette entry point.
- **Send Selection to Codex Router** appears in the editor context menu.
- The status item is concise: ready model/effort, fallback, authentication issue, or App Server issue.
- `@router` is supported only when the VS Code Chat Participant API is available. It should direct into the same routing service and recommendation flow rather than becoming a separate product.

## Production architecture

```text
VS Code extension host
  ├─ Router panel controller and native commands
  ├─ Routing service
  │   ├─ ModelDeck provider (loopback only)
  │   ├─ deterministic policy and guardrails
  │   └─ recommendation validation
  ├─ Codex App Server client (child process, stdio JSON-RPC)
  ├─ local outcome store and evaluation exporter
  └─ diagnostics service (redacted, user-visible)
```

The panel is presentation only. It must not receive authentication material or raw protocol logs. The extension host owns process lifecycle, validation, privacy filtering, and persistence.

Use a webview view for the composed panel once interaction complexity justifies it. Keep it strict: a content-security policy, nonce-based scripts, no remote content, VS Code theme tokens, keyboard support, ARIA labels, and no secrets in messages sent to the webview.

## Routing model and ModelDeck profile

Use a dedicated ModelDeck Routing Profile when the operator wants routing isolated from other local applications. Publish a single OpenAI-compatible capability initially:

```text
Display name: Codex Router Classifier
Public model ID: codex-router-classifier
Purpose: schema-constrained task classification only
```

Configure the extension with that public model ID. The routing model must be a small local instruction-following model that reliably returns compact JSON under a low temperature. It does not need coding-agent capability; classification consistency and low latency matter more.

Before relying on it, validate the exact active ModelDeck profile, model ID, `ready` state, JSON adherence, typical latency, and failure behaviour. If it is unavailable, the extension must visibly use deterministic fallback without attempting a cloud call.

## Delivery stages

### Stage 1 — reliable vertical slice

- Fix extension activation and diagnostics.
- Keep command-based flow working independently of Chat.
- Verify real App Server model discovery, ChatGPT auth validation, first turn, streaming, and cleanup with an explicit manual smoke test.
- Configure and smoke-test the dedicated ModelDeck capability.

**Exit criterion:** an explicit task can be routed, approved/overridden, sent through Codex App Server, and completed with visible recovery states.

### Stage 2 — production router panel

- Add the secondary-sidebar router panel.
- Implement stateful composer, visible sent-context preview, recommendation card, constrained overrides, and streamed transcript.
- Add accessible keyboard interaction and theme testing.
- Retain commands and `@router` as alternative entry points into the same service.

**Exit criterion:** the primary flow works without opening the VS Code Chat view or the Codex extension.

### Stage 3 — outcome evidence and evaluation

- Record opt-in privacy-safe outcomes, including explicit validation and user ratings.
- Add local export and comparison reports for fixed baselines, router choices, and user overrides.
- Integrate optional identifiers that allow manual correlation with Codex Local Meter without reading its private extension state.

**Exit criterion:** representative tasks can be compared on verification rate, repair turns, elapsed time, override rate, under-routing, and over-routing.

### Stage 4 — measured adaptation

- Add an offline report that identifies routing-policy changes worth testing.
- Introduce an opt-in contextual policy only after a sufficient, privacy-safe local evaluation set exists.
- Ship new policies as versioned, reversible local rules with a fixed baseline control.

**Exit criterion:** any automatic adaptation demonstrates no material verification regression versus the baseline.

## Reliability and security requirements

- Start App Server with `codex app-server --stdio`, argument arrays, and no network listener.
- Call `getAuthStatus` with token inclusion disabled and accept only supported ChatGPT authentication.
- Discover every model and effort from the live App Server catalogue at session start; refresh after reconnection.
- Use timeouts, request IDs, cancellation, malformed-message handling, and child-process cleanup.
- Do not store source code, complete task prompts, final answers, credentials, or raw protocol traffic in analytics.
- Respect Workspace Trust and preserve Codex sandbox/approval policies.
- Do not silently change provider, model, effort, or authentication mode.

## Explicit non-goals

- Modifying, wrapping, or automating the installed Codex extension.
- Recreating Codex’s complete agent chat experience.
- Cloud routing fallback.
- Automatic model/effort switching in the middle of an active Codex turn.
- Claiming quality gains without observable verification results.

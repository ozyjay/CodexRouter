# Codex Router: production direction

## Decision

Build Codex Router as an independent VS Code extension with its own focused router workspace. Do not attempt to inject routing into the existing Codex extension or VS Code Chat. The Codex extension is a separate product surface and does not expose a supported public composer-interception API.

The production experience should make routing intentional and inspectable before a Codex turn begins, while leaving the established Codex extension free to handle ordinary direct conversations.

## Current implementation status

The evidence-first command milestone is implemented and is now complemented by the router sidebar:

- the sidebar and commands share one routing-session controller;
- routing and execution context are separate and previewed;
- deterministic routing is the default policy;
- ModelDeck is explicitly opt-in and experimental;
- selected code can be sent to an explicitly confirmed ModelDeck proxy route for a constrained advisory patch preview, with no automatic workspace edit;
- ordinal recommendation strength replaces user-facing percentage confidence;
- App Server catalogue validation, approval-request handling, terminal states, and supported turn interruption are implemented against the inspected schema, with a live smoke test still pending;
- privacy-safe outcomes distinguish turn state from user-observed task results and can be exported or deleted.

The dedicated Activity Bar sidebar consumes the existing session controller rather than introducing another routing flow.

## Product position

Codex Router is not another general coding agent. It is a local decision layer and launchpad for Codex:

```text
Describe task → route locally → review recommendation → approve/override → run Codex → observe outcome
```

Its value is transparent model/effort selection, safe handling of consequential work, and evidence for whether adaptive routing improves outcomes. It should not duplicate broad file editing, Git, terminal, approvals, or agent-history interfaces that Codex already provides.

The ModelDeck proxy workflow remains inside that boundary. It can propose one patch against an explicitly selected excerpt, but cannot apply it. A user can discard the preview or hand it to a normal routed Codex turn for independent review and execution.

The next-level research direction is documented separately in [Adaptive orchestration and evaluation proposal](ADAPTIVE_ORCHESTRATION_PROPOSAL.md). That proposal requires a fixed Codex-native role baseline before phase-aware or subagent routing is treated as valuable.

## Primary UX

Create one **Codex Router** view in its own VS Code Activity Bar sidebar. It should be narrow enough to sit beside the editor and usable without VS Code Chat or the Codex extension being open.

### Router panel states

| State | Content | Main action |
| --- | --- | --- |
| Ready | Task composer, active file/selection toggles, service health summary | Analyse task |
| Recommendation | Model, effort, strength, concise reasons, source, context summaries, fallback and escalation signals | Use recommendation / Override |
| Running | Selected model and effort, Codex progress, streamed response, normal approval status | Open output / Cancel if supported |
| Completed | Final response summary, elapsed time, optional validation/rating capture | New routed task |
| Recovery | Clear problem and safe recovery instructions | Recheck App Server / Open settings |

The composer should include task text plus opt-in chips for the active file, selection, language, and diagnostics. Show exactly what will be sent to the local router before analysis. Do not add a “send entire workspace” control.

### Recommendation card

The recommendation card is the centre of the product. It must show:

- selected Codex model and effort;
- ordinal recommendation strength and whether the result came from the deterministic baseline or a named experimental classifier;
- no more than three concise reasons;
- relevant escalation signals;
- a model/effort override that is constrained to App Server-discovered choices;
- a small warning for guardrail escalation, for example “Security-sensitive task: Sol/high selected”.

Selecting **Use recommendation** starts a new App Server thread. Selecting **Override** opens native VS Code Quick Picks initially; the production panel may later render the same constrained controls directly.

### Secondary entry points

- **Codex Router: New Routed Task** is the universal keyboard/command-palette entry point.
- **Send Selection to Codex Router** appears in the editor context menu.
- **Generate ModelDeck Proxy Candidate for Selection** appears beside it and requires a separate context-disclosure confirmation.
- The status item is concise: ready model/effort, fallback, authentication issue, or App Server issue.

## Production architecture

```text
VS Code extension host
  ├─ Router panel controller and native commands
  ├─ Routing service
  │   ├─ deterministic policy and guardrails (default)
  │   ├─ optional ModelDeck provider (loopback only)
  │   └─ recommendation validation
  ├─ constrained ModelDeck proxy-candidate service (loopback, selected code, preview only)
  ├─ Codex App Server client (child process, stdio JSON-RPC)
  ├─ local outcome store and evaluation exporter
  └─ diagnostics service (redacted, user-visible)
```

The panel is presentation only. It must not receive authentication material or raw protocol logs. The extension host owns process lifecycle, validation, privacy filtering, and persistence.

Use a webview view for the composed panel once interaction complexity justifies it. Keep it strict: a content-security policy, nonce-based scripts, no remote content, VS Code theme tokens, keyboard support, ARIA labels, and no secrets in messages sent to the webview.

## Routing model and ModelDeck profile

Use a dedicated ModelDeck Routing Profile when the operator wants routing isolated from other local applications. Publish the classifier capability when experimental classification is required:

```text
Display name: Codex Router Classifier
Public model ID: codex-router-classifier
Purpose: schema-constrained task classification only
```

Configure the extension with that public model ID. The routing model must be a small local instruction-following model that reliably returns compact JSON under a low temperature. It does not need coding-agent capability; classification consistency and low latency matter more.

The optional selected-code workflow uses a separate coding-capable ModelDeck route:

```text
Display name: Codex Router Proxy — Balanced
Public model ID: codex-router-proxy-balanced
Purpose: one schema-constrained patch candidate over explicitly supplied source
```

Operators may point `codexRouter.modelDeck.proxyModel` at another ready public route. The extension sends only the confirmed task and selected excerpt, accepts exactly one in-file patch with uniquely applicable search text, and never applies it directly. Proxy failure is terminal for that candidate; unlike classification, it does not invoke a deterministic generated fallback.

Before relying on it, validate the exact active ModelDeck profile, model ID, `ready` state, JSON adherence, typical latency, and failure behaviour. If it is unavailable, the extension must visibly use deterministic fallback without attempting a cloud call.

## Delivery stages

### Stage 1 — reliable command vertical slice (implemented; live smoke pending)

- Fix extension activation and diagnostics.
- Keep command-based flow working independently of Chat.
- Verify real App Server model discovery, ChatGPT auth validation, first turn, streaming, and cleanup with an explicit manual smoke test.
- Keep ModelDeck disabled by default and smoke-test the dedicated capability only when explicitly enabled.
- Keep the ModelDeck proxy command user-initiated, disclosure-gated, and preview-only.

**Exit criterion:** an explicit task can be routed, approved/overridden, sent through Codex App Server, and completed with visible recovery states.

### Stage 2 — production router panel (implemented; live smoke pending)

- Add the Activity Bar router panel.
- Implement stateful composer, visible sent-context preview, recommendation card, constrained overrides, and streamed transcript.
- Add accessible keyboard interaction and theme testing.
- Retain commands as alternative entry points into the same service.

**Exit criterion:** the primary flow works without opening the VS Code Chat view or the Codex extension.

### Stage 3 — outcome evidence and evaluation

- Extend the implemented opt-in privacy-safe outcome records and basic Markdown export with richer evaluation views.
- Compare fixed baselines, router choices, and user overrides without mixing subjective telemetry with matched live evidence.
- Integrate optional identifiers that allow manual correlation with Codex Local Meter without reading its private extension state.

**Exit criterion:** representative tasks can be compared on verification rate, repair turns, elapsed time, override rate, under-routing, and over-routing.

### Stage 4 — measured adaptation

- Add an offline report that identifies routing-policy changes worth testing.
- Introduce an opt-in contextual policy only after a sufficient, privacy-safe local evaluation set exists.
- Ship new policies as versioned, reversible local rules with a fixed baseline control.

**Exit criterion:** any automatic adaptation demonstrates no material verification regression versus the baseline.

## Reliability and security requirements

- Start App Server with `codex app-server --stdio`, argument arrays, and no network listener.
- Call the version-matched `account/read` interface without requesting token material and accept only supported ChatGPT authentication.
- Discover every model and effort from the live App Server catalogue at session start; refresh after reconnection.
- Use timeouts, request IDs, cancellation, malformed-message handling, and child-process cleanup.
- Do not store source code, complete task prompts, final answers, credentials, or raw protocol traffic in analytics.
- Respect Workspace Trust and preserve Codex sandbox/approval policies.
- Do not silently change provider, model, effort, or authentication mode.
- Never auto-apply a local proxy patch or treat it as trusted Codex output.

## Explicit non-goals

- Modifying, wrapping, or automating the installed Codex extension.
- Recreating Codex’s complete agent chat experience.
- Cloud routing fallback.
- Automatic model/effort switching in the middle of an active Codex turn.
- Claiming quality gains without observable verification results.

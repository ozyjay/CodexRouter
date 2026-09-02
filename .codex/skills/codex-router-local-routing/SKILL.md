---
name: codex-router-local-routing
description: Change deterministic routing, ModelDeck classification or proxy candidates, recommendation validation, and routing safety guardrails.
---

# Codex Router local routing

Use this skill for `src/routing.ts`, `src/policy.ts`, `src/modelDeck.ts`, `src/proxy.ts`, and their contracts or tests.

- Keep deterministic routing as the default and preserve visible fallback when experimental classification is unavailable, malformed, unsafe, or unsupported.
- Accept only literal loopback ModelDeck endpoints (`127.0.0.1` or `::1`); do not add a cloud fallback or send workspace content by default.
- Validate every local result before use, including JSON shape, confidence, rationale bounds, known model IDs, and live-catalogue-supported efforts.
- Treat proxy candidates as untrusted, disclosure-gated, selected-excerpt-only advice. They must remain one strict applicable patch preview, never edit the workspace automatically, and fail closed without a generated fallback.
- Preserve guardrail escalation and disclose allocation substitutions rather than silently changing provider, model, or effort.

Add focused routing, ModelDeck, or proxy tests and run `npm run check`.

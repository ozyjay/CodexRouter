---
name: codex-router-app-server
description: Change Codex App Server protocol, catalogue, authentication, streaming, approval, cancellation, or process-lifecycle behaviour.
---

# Codex Router App Server work

Use this skill when changing the supported App Server boundary in `src/appServer.ts` or its callers.

- Establish the version-matched supported request and response shape before making protocol assumptions; `account/read` must never obtain token material, and `model/list` remains authoritative for models and reasoning efforts.
- Spawn `codex app-server --stdio` with an argument array and `shell: false`; retain request IDs, bounded failures, cancellation, malformed-message handling, and deactivation cleanup.
- Preserve Codex approval and sandbox behaviour. Allocation changes apply only before a new turn begins.
- Keep normal tests on fake transports and do not start a real Codex turn unless the user explicitly opts in.
- Never record or display credentials, raw App Server messages, full task prompts, or generated output in diagnostics or outcomes.

Update focused App Server/session tests and run `npm run check`.

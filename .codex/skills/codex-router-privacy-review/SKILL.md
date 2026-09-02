---
name: codex-router-privacy-review
description: Review Codex Router changes for privacy or security risks in task context, source selection, telemetry, diagnostics, protocol traffic, or webview messages.
---

# Codex Router privacy review

Use this skill for an explicit privacy or security review, or when a change crosses a data-disclosure, persistence, diagnostics, or deletion boundary. Do not use it for ordinary implementation work that has no such boundary.

- Trace each affected value from ingress through disclosure, validation, presentation, diagnostics, persistence, export, and deletion. Identify which actor receives it and whether consent or opt-in is required.
- Protect task text, source code and paths, selected excerpts, generated answers, raw App Server traffic, and credentials. Outcomes must remain opt-in and privacy-safe.
- Verify local inference uses only literal loopback endpoints, selected-code proxy use has separate disclosure confirmation, and no fallback can transmit data to a cloud service.
- Confirm webviews receive only presentation-safe data and preserve Codex approvals and sandbox protections.
- Report concrete findings with severity, affected boundary, and evidence. Do not expand review authority into unrelated implementation changes without user direction.

When the review includes code changes, require focused tests and `npm run check`; otherwise report the review without modifying the repository.

---
name: codex-router-panel-ui
description: Build or review the Codex Router sidebar or webview user interface, including accessibility, theme support, and recovery states.
---

# Codex Router panel UI

Use this skill for the Activity Bar sidebar, webview markup or messaging, and related VS Code presentation code.

- Keep the panel presentation-only: extension-host code owns process lifecycle, validation, persistence, authentication state, and sensitive data.
- Preserve a strict webview CSP with nonce-based scripts and no remote content. Do not send credentials, raw protocol traffic, or unredacted diagnostics to the webview.
- Use VS Code theme tokens and native controls where practical. Support keyboard operation, accessible names, and readable focus states.
- Make unavailable states actionable: rejected ChatGPT authentication, unavailable App Server or ModelDeck, local fallback, and no model catalogue must remain explicit.
- Retain the task-context preview and explicit recommendation approval or override; do not create a second execution flow in the panel.

Update focused tests where feasible, manually inspect relevant interaction states, and run `npm run check`.

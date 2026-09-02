---
name: codex-router-extension-workflow
description: Develop cross-cutting Codex Router extension flows involving commands, @router, the sidebar, sessions, or lifecycle handling.
---

# Codex Router extension workflow

Use this skill for changes that span extension entry points or lifecycle code. Keep commands, the optional `@router` participant, and the sidebar on the shared routing-session controller; do not introduce a competing routing or execution flow.

- Trace the affected path from `src/extension.ts` through `src/session.ts` and the relevant service before editing.
- Preserve explicit recommendation approval or override before an App Server turn starts, and retain command-palette and selection commands as reliable fallbacks.
- Keep extension-host responsibilities out of the webview, including process lifecycle, validation, persistence, and sensitive state.
- Add focused coverage beside the changed contract, then run `npm run check`.

For UI-specific work, also use `codex-router-panel-ui`. For App Server protocol changes, use `codex-router-app-server`.

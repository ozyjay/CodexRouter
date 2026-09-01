# Codex Router contributor guide

Codex Router is a local, privacy-preserving VS Code companion. It recommends a Codex model and reasoning effort, lets the user approve or override the choice, then starts a Codex App Server turn using the user’s existing ChatGPT authentication.

## Product boundaries

- Keep Codex Router a focused task-routing launchpad. Do not recreate the Codex IDE extension or assume access to its private UI, state, commands, or threads.
- Use supported VS Code extension APIs and Codex App Server stdio only. Do not use UI automation or patch installed extensions.
- Codex turns must use the existing ChatGPT sign-in. Never request, read, parse, display, transmit, or log `~/.codex/auth.json`, authentication tokens, `OPENAI_API_KEY`, or Platform API credentials.
- Treat App Server `model/list` and each model’s `supportedReasoningEfforts` as the authority. Do not hard-code an assumed catalogue or unsupported combinations.
- Apply model and effort changes only before a new turn starts. Do not interrupt an active Codex turn only to change routing.

## Privacy and local routing

- Router inference must stay local. ModelDeck endpoints must use literal loopback addresses (`127.0.0.1` or `::1`); do not add cloud fallback.
- Send the router only the user task, explicitly selected content, and compact metadata required for classification. Never send the complete workspace by default.
- Never log complete task prompts, repository content, generated model output, raw App Server protocol messages, or credentials.
- Outcome records are opt-in. Store only the documented privacy-safe metadata and retain the one-way workspace identifier; do not add source paths or task text.
- Preserve Codex approval and sandbox behaviour. Do not weaken safety controls to improve the apparent success rate.

## UX direction

- The primary UX is a dedicated, small Codex Router panel or view, with a task composer, recommendation card, explicit approval/override, and streamed result.
- `@router` is an optional VS Code Chat entry point. It must not be required, because the Chat Participant API may not be present in every host and it cannot be embedded in the Codex extension’s private composer.
- Keep command-palette and editor-selection commands as reliable fallbacks.
- Prefer native VS Code controls. Use a webview only for the composed router panel where native controls cannot express the approval and streaming flow well.
- Make unavailable states explicit: ChatGPT authentication rejected, App Server unavailable, ModelDeck unavailable, local fallback selected, and no model catalogue.

## Engineering standards

- Use TypeScript with strict compilation and maintain small modules with explicit contracts.
- Use PowerShell (`pwsh -NoProfile`) as the primary interface for project operations, automation, and documented commands. Package tasks are routed through `scripts/invoke.ps1`; use Bash only for an explicitly documented platform-specific exception.
- Spawn child processes with argument arrays and `shell: false`. Clean up child processes when the extension deactivates.
- Validate every local-model result before using it. Reject malformed JSON, out-of-range confidence values, long rationales, unknown model IDs, and unsupported efforts.
- Maintain fake transports for App Server and ModelDeck tests. Normal tests must not invoke a real Codex turn or consume ChatGPT allowance.
- Use Australian English in documentation, comments, UI strings, and diagnostics.

## Verification

Before handing off a change, run:

```powershell
npm run check
```

Run a real Codex App Server/ModelDeck smoke test only when the user explicitly opts in, because it can consume their ChatGPT allowance and relies on local runtime state. Document any live assumptions that remain unverified.

## Documentation

- Update `README.md` when configuration, commands, privacy, architecture, or manual validation changes.
- Keep [docs/PRODUCTION_DIRECTION.md](docs/PRODUCTION_DIRECTION.md) current when product architecture or delivery phases change.
- Keep [docs/ADAPTIVE_ORCHESTRATION_PROPOSAL.md](docs/ADAPTIVE_ORCHESTRATION_PROPOSAL.md) current when the custom-agent baseline, phase-aware routing, or evaluation methodology changes.

# Adaptive orchestration and evaluation proposal

## Purpose

This proposal extends Codex Router from a per-turn model and reasoning recommender into a narrow adaptive policy and evaluation layer over supported Codex turns, subagents, and custom-agent configuration.

It does **not** propose rebuilding Codex’s agent loop, tool execution, planning, approvals, sandbox, context management, thread manager, result consolidation, or general chat interface.

The research question is:

> Can local routing and evidence-based allocation reduce latency and ChatGPT Codex usage while preserving verified software-engineering quality, compared with fixed models and Codex-native role configuration?

## Local routing-provider choice

The local model that classifies a task must be independently selectable from the Codex model that executes the approved task. ModelDeck is the initial provider, but the routing boundary should support a generic local OpenAI-compatible provider, with named presets for ModelDeck, Ollama, and LM Studio.

```text
Routing provider: ModelDeck | Ollama | LM Studio | deterministic fallback
                                      ↓
                    validated recommendation and user approval
                                      ↓
Execution backend: Codex App Server using existing ChatGPT authentication
```

This is not a proposal to make Ollama, LM Studio, or ModelDeck execute Codex turns. Codex App Server remains the sole execution backend and its live model catalogue remains authoritative for selectable Codex models and reasoning efforts.

Each provider integration must:

- use a literal loopback HTTP(S) endpoint only;
- discover or explicitly configure its local classifier model without assuming provider-specific model identifiers;
- use a compact, schema-constrained prompt and strictly validate the returned recommendation;
- enforce bounded timeouts and show the active provider and any failure clearly; and
- fall back to deterministic local rules without any cloud-routing request.

Implement the generic OpenAI-compatible provider before provider-specific adapters. A native adapter is justified only where an OpenAI-compatible endpoint cannot provide the required discovery, structured-output, or reliability behaviour.

## Design principle

Codex Router must first establish what existing Codex configuration can already achieve. Adaptive routing is valuable only when it outperforms a reproducible fixed-role baseline, not merely when it uses multiple models or subagents.

All claims about installed Codex behaviour, custom-agent precedence, subagent selection, model availability, and effort levels must be confirmed from the installed CLI/App Server schema and supported documentation before becoming implementation assumptions.

## Narrow responsibility

At supported boundaries, the router may recommend or decide:

1. whether a task remains one Codex turn or has explicit sequential phases;
2. whether independent work justifies delegation to a subagent;
3. the agent role for each phase;
4. the discovered Codex model and reasoning effort for the parent and each subagent;
5. whether later work should retain, escalate, or reduce allocation after observable outcomes.

It must not change a model or effort inside an active generation, or interrupt a successful in-flight turn solely to re-route it.

## Fixed custom-agent baseline

Before adaptive routing, create a reproducible Codex-native baseline using the supported `.codex/agents/` and `.codex/config.toml` capabilities after verifying their current schema and precedence rules.

The provisional roles are experimental defaults, not hard-coded product rules:

| Role | Purpose | Provisional allocation |
| --- | --- | --- |
| Explorer | Read-heavy repository discovery and task decomposition | Luna, low or medium |
| Worker | Bounded implementation and ordinary debugging | Terra, medium |
| Reviewer | Correctness, security, and test-gap review | Sol, high |

Document how to invoke this baseline through Codex CLI and, where supported, through Codex’s normal client. The baseline must work without the Codex Router extension or any local routing provider.

## Required comparisons

Evaluate the same representative task suite against:

1. fixed single model and effort;
2. user-selected model and effort;
3. fixed Explorer/Worker/Reviewer roles;
4. deterministic routing rules;
5. each enabled local routing provider's recommendations;
6. later phase-aware adaptive routing.

Measure verified completion, test/build success, repair turns, elapsed time, user overrides, under-routing, unnecessary over-routing, phase/subagent costs, and coordination overhead. Where available, record usage data through supported interfaces or correlate manually with Codex Local Meter; do not read another extension’s private state.

Report raw elapsed time only as a diagnostic. Compare strategy efficiency through average duration of verified runs and total evaluation time per verified completion, so failures and no-op runs cannot improve a strategy's apparent speed.

Use a deterministic, explicitly labelled simulation backend to test worktree isolation, quality gates, reporting, and failure accounting without consuming Codex allowance. Simulation must never be presented as a result for Luna, Terra, Sol, or any live Codex allocation; use live App Server runs only to support those claims.

Constrained local proxy candidates may complement deterministic simulation after the latter is established. They must receive only manifest-declared task context, modify only manifest-declared contextual files through a strict patch contract, and fail closed on malformed or inapplicable output. Run exactly one distinct proxy-candidate strategy per case iteration; fixed Codex roles are not part of that local-proxy execution. Snapshot selector and proxy route identities at cohort start and fail if they drift during the cohort. Report them as local-proxy workflow evidence, separately from both deterministic-harness and live Codex results.

Start with narrow tasks whose requested change, target test, and expected assertion are explicit. For each task, evaluate privacy-safe booleans that the temporary-worktree diff contains the required evidence, normal validation succeeds, and controlled fault injection is detected where the task adds a regression test. Run matched repeated trials for each strategy; a passing check without the requested evidence or a killed mutation is not verified completion.

Prioritise avoiding under-routing on consequential work. A saving is not a success if verified quality regresses.

## Future-compatible execution strategy contract

The first shipped routing contract remains per-turn. A later version may represent execution strategy as well as allocation:

```json
{
  "executionStrategy": "sequential_phases",
  "parent": {
    "model": "gpt-5.6-terra",
    "effort": "medium"
  },
  "phases": [
    {
      "name": "exploration",
      "agentRole": "explorer",
      "model": "gpt-5.6-luna",
      "effort": "medium",
      "parallelisable": false
    },
    {
      "name": "implementation",
      "agentRole": "worker",
      "model": "gpt-5.6-terra",
      "effort": "medium",
      "parallelisable": false
    },
    {
      "name": "review",
      "agentRole": "reviewer",
      "model": "gpt-5.6-sol",
      "effort": "high",
      "parallelisable": false
    }
  ],
  "confidence": 0.82,
  "reasons": ["Map the relevant code path before editing", "Use an independent review phase"],
  "escalationSignals": ["Tests fail after two repair turns", "The change becomes architectural"]
}
```

This is conceptual only. The implementation must validate every proposed model and effort against the live App Server catalogue, confirm custom-agent/subagent support, and reject strategies whose interfaces are unavailable.

## Deterministic decision rules

Before a router proposes multiple phases or subagents, it must establish that:

- the work genuinely benefits from exploration, implementation, or independent review;
- phases are independent enough to parallelise without conflicting edits or excess coordination;
- every chosen model and effort is currently supported;
- additional ChatGPT allowance and latency are justified against a lower-cost single turn;
- the task is not narrow enough for a single Luna or Terra turn.

Small, explicit tasks must not automatically spawn multiple agents. Security-sensitive, destructive, migration, concurrent, broad, ambiguous, or repeatedly failing work should receive conservative escalation.

## Outcome attribution

The local metadata contract must evolve to distinguish:

- parent turn, phase, and subagent identifiers;
- model and effort for every participant;
- phase duration, validation result, retry count, and escalation/de-escalation;
- parallel-work conflicts and context/coordination overhead;
- user overrides and the final verified task result.

Do not infer routing success solely from a final passing task. Record whether an early low allocation created avoidable repair work and whether an expensive allocation was unnecessary.

No outcome record may contain task text, source code, complete generated output, credentials, or raw App Server protocol messages.

## Revised delivery order

1. Inspect the installed Codex CLI, version-matched App Server schema, and supported custom-agent/subagent interfaces.
2. Record confirmed model selection, effort, multi-step, and delegation behaviour.
3. Create and validate the fixed custom-agent baseline.
4. Define repeatable evaluation tasks and verified success measures.
5. Implement a deterministic advisory router without a local routing provider.
6. Compare fixed single-model, user-selected, fixed-role, and deterministic baselines.
7. Add the generic local OpenAI-compatible structured classifier, initially configured for ModelDeck.
8. Add and evaluate Ollama and LM Studio presets, retaining only providers that meet the same privacy and reliability contract.
9. Add App Server submission and per-turn override flow.
10. Add phase-aware routing and subagent assignment only where the supported interface is confirmed.
11. Add outcome attribution and adaptive recommendations.
12. Consider automatic routing only after advisory recommendations are demonstrably reliable.

## Updated success criterion

Codex Router succeeds only by showing transparent, reproducible value beyond existing Codex configuration. Valid outcomes include lower elapsed time or usage for equivalent verified quality, fewer inadequate-model failures, fewer unnecessary high-effort turns, useful escalation, and fewer manual selection decisions.

It is also a valid and valuable result if fixed Codex-native role routing performs as well as adaptive routing. In that case, the simpler native configuration is preferable and the project should report that conclusion plainly.

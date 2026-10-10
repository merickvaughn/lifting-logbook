# ADR-016: Cycle Planning Agent — LLM Integration, Tool Schema, and Adapter Boundary

**Status:** Accepted
**Date:** 2026-04-21
**Closes:** [#55](https://github.com/merickvaughn/lifting-logbook/issues/55)

> **Renamed by [ADR-038](ADR-038-training-time-vocabulary.md):** the agent is `IMacrocyclePlanningAgent` behind `POST /macrocycle-plan`, and its environment variables are `MACROCYCLE_AGENT_{PROVIDER,MODEL,BASE_URL,API_KEY}`. The `CYCLE_AGENT_*` names below are no longer read. The body is kept as written.

---

## Context

Issue [#54](https://github.com/merickvaughn/lifting-logbook/issues/54) proposes a cycle planning agent: the user states a training goal (e.g., "peak my squat for a meet in 8 weeks"), and the agent reasons over lift history, training maxes, and program configuration to produce a structured cycle plan with training max adjustments and reasoning.

Four design questions require explicit decisions before implementation begins in v0.3:

1. Which LLM provider and model, and how is provider-swappability maintained?
2. What domain data does each tool expose, and where is the tool/port boundary drawn?
3. Where does the agent adapter live in the hexagonal architecture?
4. What is the endpoint surface, and is multi-turn agent state in scope for v0.3?

---

## Decision

### 1. LLM Provider, Model, and Swappability

Use the **Anthropic Claude API** via `@anthropic-ai/sdk`. Default model: `claude-sonnet-4-6`.

Rationale for Sonnet over Haiku: cycle planning requires interpreting multi-cycle lift history, reasoning about progression rates, and surfacing coherent justifications. This exceeds the "mechanical/summarise" category where Haiku is appropriate. Sonnet is the correct tier for "standard dev reasoning applied to a domain problem." Haiku is available as an override for cost-sensitive deployments.

Swappability is enforced at the port boundary (see §3). The adapter is `anthropic-cycle-planning.adapter.ts`; a future `gemini-cycle-planning.adapter.ts` or `openai-cycle-planning.adapter.ts` would implement the same port interface with no changes to callers or domain code.

The model ID is injected via NestJS `ConfigService` (`CYCLE_AGENT_MODEL`), defaulting to `claude-sonnet-4-6`. This allows per-environment overrides (e.g., `claude-haiku-4-5-20251001` in local dev) without code changes. Anthropic deprecates model versions on a published schedule; `CYCLE_AGENT_MODEL` is the operational knob for keeping the default current — the ADR default will need to be updated when `claude-sonnet-4-6` is deprecated. See [Anthropic model deprecation policy](https://docs.anthropic.com/en/docs/deprecations) for the current timeline.

### 2. Tool Schema Design

The agent has read access to four domain tools and submits its output via a fifth structured tool call. All tool inputs and outputs use domain types from `packages/core`.

#### `get_lift_history`

Retrieves `LiftRecord[]` for a specified program and cycle number. Lets the agent inspect recent performance — actual reps, weights, and AMRAP sets — to evaluate progression readiness before proposing changes.

```json
{
  "name": "get_lift_history",
  "description": "Retrieve all lift records logged for a given program cycle. Use this to assess recent performance — actual weights lifted, reps completed (including AMRAP sets), and trends across workouts. Call once per cycle; typically called for 1–3 recent cycles to establish a progression trend.",
  "input_schema": {
    "type": "object",
    "properties": {
      "program":   { "type": "string", "description": "Program identifier (e.g. 'my-531')" },
      "cycle_num": { "type": "integer", "description": "Cycle number to retrieve (1-indexed)" }
    },
    "required": ["program", "cycle_num"]
  }
}
```

Maps to: `ILiftRecordRepository.getLiftRecords(program, cycleNum)`

**Budget note:** This tool fetches one cycle per call. An agent examining 3 prior cycles consumes 3 of 5 available tool rounds before calling the remaining read tools. The default `MAX_TOOL_ROUNDS = 5` is calibrated for a 3-history-cycle pattern (3× `get_lift_history` + `get_training_maxes` + `get_program_spec` = 5 read calls, leaving `propose_cycle_plan` as the terminal call outside the loop budget). If the expected history depth changes, `MAX_TOOL_ROUNDS` must be adjusted accordingly.

#### `get_training_maxes`

Retrieves `TrainingMax[]` — the current training max weight and last-updated date per lift. The agent needs this to understand the baseline from which any proposed increase would be calculated.

```json
{
  "name": "get_training_maxes",
  "description": "Retrieve current training maxes for all lifts in a program. Returns lift name, current training max weight, and the date it was last updated.",
  "input_schema": {
    "type": "object",
    "properties": {
      "program": { "type": "string", "description": "Program identifier" }
    },
    "required": ["program"]
  }
}
```

Maps to: `ITrainingMaxRepository.getTrainingMaxes(program)`

#### `get_program_spec`

Retrieves `LiftingProgramSpec[]` — the full program configuration including sets, reps, increment amounts, warmup percentages, and AMRAP flags. The agent uses this to understand the progression rules in effect (e.g., how much weight is added each cycle) and to reason about whether a proposed change is consistent with the program's design.

```json
{
  "name": "get_program_spec",
  "description": "Retrieve the program specification: sets, reps, increment amounts, warmup percentages, and AMRAP flags for each lift. Use this to understand the progression rules before proposing changes.",
  "input_schema": {
    "type": "object",
    "properties": {
      "program": { "type": "string", "description": "Program identifier" }
    },
    "required": ["program"]
  }
}
```

Maps to: `ILiftingProgramSpecRepository.getProgramSpec(program)`

#### `get_cycle_dashboard`

Retrieves `CycleDashboard` — the current cycle number, cycle start date, cycle unit, and preferred start weekday. This is the only tool that exposes scheduling data. Without it the agent cannot reason about time-bounded goals (e.g., "peak in 8 weeks") because it has no way to project how many cycles fit within the target window.

```json
{
  "name": "get_cycle_dashboard",
  "description": "Retrieve the current cycle dashboard: cycle number, start date, cycle unit, and preferred start weekday. Use this when the goal involves a time horizon (e.g. 'peak in 8 weeks') to determine how many cycles are available before the target date.",
  "input_schema": {
    "type": "object",
    "properties": {
      "program": { "type": "string", "description": "Program identifier" }
    },
    "required": ["program"]
  }
}
```

Maps to: `ICycleDashboardRepository.getCycleDashboard(program)`

#### `propose_cycle_plan`

The agent submits its final recommendation as a structured tool call rather than as free-form text. This makes the output machine-parseable and directly actionable: the adapter maps the tool result to a `CyclePlanResult` before returning it to the caller. Using a tool call for output (rather than parsing unstructured text) eliminates brittle JSON-extraction logic and keeps the output contract explicit.

```json
{
  "name": "propose_cycle_plan",
  "description": "Submit the final training cycle plan. Call this once you have reviewed lift history, training maxes, and program spec and are ready to propose specific changes. Do not call this tool more than once.",
  "input_schema": {
    "type": "object",
    "properties": {
      "proposed_changes": {
        "type": "array",
        "description": "One entry per lift where a training max change is recommended. Omit lifts with no change.",
        "items": {
          "type": "object",
          "properties": {
            "lift":             { "type": "string", "description": "Lift name (e.g. 'Squat')" },
            "current_weight":   { "type": "number", "description": "Current training max weight as returned by get_training_maxes — state the value you observed so the adapter can verify it matches the live data" },
            "proposed_weight":  { "type": "number", "description": "Proposed new training max weight" },
            "reasoning":        { "type": "string", "description": "Why this change is recommended" }
          },
          "required": ["lift", "current_weight", "proposed_weight", "reasoning"]
        }
      },
      "overall_reasoning": {
        "type": "string",
        "description": "Summary of the plan relative to the user's stated goal"
      }
    },
    "required": ["proposed_changes", "overall_reasoning"]
  }
}
```

#### Tool boundary rule

Tools expose only the data the agent needs to reason about cycle-level progression. No write-path tool is exposed: `propose_cycle_plan` returns a *proposal* that is presented to the user for confirmation before any mutation is committed. The adapter never calls `saveCycleDashboard` or `saveTrainingMaxes` — persistence is deferred to a separate user-confirmed commit step.

### 3. Adapter Boundary in Hexagonal Architecture

The agent adapter lives entirely in the infrastructure layer of `apps/api`. The boundary follows the same dependency-inversion rule as every other adapter in this codebase (ADR-002): the port interface is inward-facing; the Anthropic SDK is outward-facing.

```
packages/core/                         ← domain logic; no LLM dependency
apps/api/src/
  ports/
    ICyclePlanningAgent.ts             ← port interface (inward; no Anthropic import)
  adapters/
    llm/
      anthropic-cycle-planning.adapter.ts   ← implements ICyclePlanningAgent using @anthropic-ai/sdk
  transport/
    rest/
      cycle-plan/
        cycle-plan.controller.ts       ← POST /api/cycle-plan → calls ICyclePlanningAgent
        cycle-plan.module.ts
```

**Port interface (`ICyclePlanningAgent`):**

```typescript
// apps/api/src/ports/ICyclePlanningAgent.ts

import { RepositoryBundle } from './factory';

export interface CyclePlanRequest {
  /** Program identifier scoping all tool calls */
  program: string;
  /** User-stated training goal in natural language */
  goal: string;
  /** Current cycle number; passed to get_lift_history as the starting context cycle */
  cycleNum: number;
}

export interface ProposedTrainingMaxChange {
  lift: string;
  /** Sourced from the agent's propose_cycle_plan `current_weight` field.
   *  The adapter validates this against the get_training_maxes result to catch
   *  cases where the agent reasoned from a stale value. */
  currentWeight: number;
  proposedWeight: number;
  reasoning: string;
}

export interface CyclePlanResult {
  proposedChanges: ProposedTrainingMaxChange[];
  overallReasoning: string;
  /** true if the agent hit a token or turn budget before completing */
  partial: boolean;
}

export interface ICyclePlanningAgent {
  plan(repos: RepositoryBundle, request: CyclePlanRequest): Promise<CyclePlanResult>;
}
```

The adapter constructs the tool schemas, manages the agentic loop (call API → dispatch tool → append result → repeat), and maps the final `propose_cycle_plan` tool call to `CyclePlanResult`. The adapter imports `@anthropic-ai/sdk`; the port interface does not.

`RepositoryBundle` is passed to `plan()` for the same reason it is passed to `DataLoaderService` (ADR-015): the factory resolves the correct per-user adapter before the call reaches the agent. The agent adapter calls the existing port interfaces — it does not reach around them.

### 4. Endpoint Surface

**v0.3 scope: `POST /api/cycle-plan` — single-turn REST action endpoint.**

```
POST /api/cycle-plan
Authorization: Bearer <token>
Content-Type: application/json

{ "program": "my-531", "goal": "peak my squat for a meet in 8 weeks", "cycleNum": 14 }

→ 200 OK
{
  "proposedChanges": [
    { "lift": "Squat", "currentWeight": 315, "proposedWeight": 325, "reasoning": "..." }
  ],
  "overallReasoning": "...",
  "partial": false
}
```

A REST action endpoint is chosen over a GraphQL mutation for two reasons:

1. **Streaming path stays open.** A `POST` endpoint can upgrade to chunked transfer encoding or Server-Sent Events without changing the mutation schema. GraphQL subscriptions require a WebSocket transport layer not yet in scope.
2. **Latency is not hidden.** A GraphQL mutation has the same latency, but the REST shape makes it explicit that this is a long-running operation with a direct response, not a field resolver.

Multi-turn agent state is **not in scope for v0.3**. The agent completes its reasoning within a single request. If the agentic loop requires more than `MAX_TOOL_ROUNDS` (default: 5) tool calls to produce a proposal, it returns `partial: true` and the best partial result.

### 5. Cost and Latency Guardrails

| Guardrail | Mechanism | Default |
|---|---|---|
| Token budget | `max_tokens` on the Anthropic API request | 4096 output tokens |
| Turn budget | Loop counter in the adapter; exits after N tool-call rounds | 5 rounds |
| Request timeout | `Promise.race` inside the adapter between the agentic loop and a deadline timer | 30 seconds |
| Hard timeout backstop | NestJS `TimeoutInterceptor` on the cycle-plan controller — fires only if the adapter deadline is missed (e.g., hung I/O) | 35 seconds |
| Partial result | `partial: true` flag on `CyclePlanResult` if turn budget or adapter deadline exceeded before `propose_cycle_plan` is called | — |

The adapter owns the primary deadline via `Promise.race`. When the deadline fires, the adapter catches it and returns the most complete `CyclePlanResult` available — a zero-change proposal with `partial: true` if `propose_cycle_plan` was never reached. The NestJS `TimeoutInterceptor` is a backstop for cases where the adapter itself hangs; when it fires it throws a 408 response and no partial result is returned. The 5-second gap between the two timeouts (30 s adapter, 35 s interceptor) ensures the adapter's graceful path runs first under normal conditions.

---

## Rationale

### Why `propose_cycle_plan` as a tool call rather than parsed text output

Requiring the agent to emit its recommendation as a structured tool call removes the need for JSON extraction from a free-form assistant message. The tool schema is the output contract — any deviation is a tool-call validation error at the SDK level, not a silent parse failure. This approach is documented as a recommended pattern in the Anthropic tool use guide.

### Why single-turn for v0.3

Multi-turn requires durable session state: the partial conversation must be stored between requests and rehydrated on the next call. The v0.3 implementation can deliver meaningful value — a full cycle plan with reasoning — without that complexity. Single-turn is the simplest thing that fulfils the acceptance criteria. Multi-turn can be added in v0.4 with a `conversationId` parameter and a session store adapter behind a new port interface.

### Why REST over GraphQL mutation for the endpoint

The cycle planning operation is a long-running, side-effect-free computation that returns a large structured result. It does not benefit from the field selection or nested resolver features that motivate GraphQL. A REST endpoint is simpler to implement, easier to test, and leaves the streaming upgrade path open without schema changes.

### Why `RepositoryBundle` is passed into the adapter at call time

The agent must operate on the authenticated user's data store configuration (ADR-003). Passing the resolved `RepositoryBundle` — rather than calling `IRepositoryFactory.forUser()` inside the adapter — keeps the adapter consistent with the rest of the infrastructure layer: adapter construction is separated from per-request scoping. The controller resolves the bundle via `IRepositoryFactory` and passes it to `ICyclePlanningAgent.plan()`, matching the pattern already used by NestJS request-scoped providers.

---

## Consequences

- A new `ICyclePlanningAgent` port interface is added to `apps/api/src/ports/`. Future alternative LLM providers implement this interface without touching callers or domain code.
- `@anthropic-ai/sdk` is a dependency of `apps/api` only, not of `packages/core` or `packages/types`. The ESLint import restriction in `packages/core` already blocks this path.
- The agent never writes to any repository. All proposed changes require an explicit user-confirmation step (a separate endpoint, not in scope for v0.3) before any mutation is committed.
- `MAX_TOOL_ROUNDS` and `max_tokens` are intentionally conservative defaults. Real-world performance data from v0.3 will inform whether they need adjustment.
- Adding a new domain tool is a bounded change: add the tool schema to the adapter, map the tool call to the appropriate port interface, and update the system prompt. The port interface and controller are unchanged.

---

## Alternatives Considered

**LangChain or Vercel AI SDK as the integration layer:** These provide higher-level abstractions over LLM tool use. Ruled out because they add a dependency with its own abstractions between the application code and the Anthropic SDK. For a codebase that already has a port/adapter layer for swappability, the SDK-direct approach is more transparent and easier to reason about at the boundary.

**GraphQL mutation for the endpoint:** Equivalent in latency and correctness, but adds complexity for streaming upgrades and does not benefit from GraphQL's field selection features given the flat output schema. Deferred — can be added as an alias in v0.4 if the frontend prefers a single transport.

**Multi-turn with session state from v0.3:** Richer UX but requires a new `ISessionStore` port, a durable session adapter, and session ID management in the client. Too much scope for a feature whose core value is the single-turn recommendation. Multi-turn is a follow-on capability, not a prerequisite.

**Model: `claude-haiku-4-5-20251001`:** Lower cost, but cycle planning requires domain reasoning over multi-week lift history — not mechanical text transformation. Haiku is available as a `CYCLE_AGENT_MODEL` override for cost-sensitive deployments; Sonnet is the quality-first default.

---

## References

- [Anthropic — Tool Use (Function Calling)](https://docs.anthropic.com/en/docs/tool-use) — The Anthropic guide to tool use with the Messages API; documents the tool schema format, the agentic loop pattern, and the `propose_<output>` tool pattern for structured output.
- [Anthropic Node.js SDK (`@anthropic-ai/sdk`)](https://github.com/anthropics/anthropic-sdk-node) — The SDK used in the adapter; documents `client.messages.create()` and the `tool_use` / `tool_result` message block types.
- [Anthropic — Model Deprecation Policy](https://docs.anthropic.com/en/docs/deprecations) — Anthropic's published deprecation timeline for model versions; the `CYCLE_AGENT_MODEL` env var must be kept current as `claude-sonnet-4-6` ages out.
- [Alistair Cockburn — Hexagonal Architecture (2005)](https://alistair.cockburn.us/hexagonal-architecture/) — The Ports and Adapters pattern governing the `ICyclePlanningAgent` boundary design; the dependency rule (infrastructure depends on domain, never the reverse) applies to the LLM adapter as it does to every other adapter in this codebase.
- [ADR-002](ADR-002-ports-and-adapters.md) — The hexagonal architecture decision for this codebase; the `ICyclePlanningAgent` port follows the same dependency-inversion rule as `IAuthProvider`, `IWorkoutRepository`, and all other ports.
- [ADR-003](ADR-003-per-user-data-store-config.md) — Per-request adapter resolution via `IRepositoryFactory`; the `RepositoryBundle` passed into `ICyclePlanningAgent.plan()` comes from this factory.

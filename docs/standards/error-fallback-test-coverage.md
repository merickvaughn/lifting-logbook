# Coding Standard: Test Coverage for Error-Swallowing Fallbacks

**Applies to:** all packages and apps — anywhere a server component or API boundary swallows an error with a fallback value
**Status:** Active
**Related issue:** [#349 — Audit and remediate skewed tests across the codebase](https://github.com/merickvaughn/lifting-logbook/issues/349)
**Related ADR:** [ADR-023 — Staging Integration Test Design](../adr/ADR-023-staging-integration-test-design.md)

---

## Rule

When code swallows an error with a fallback value — `.catch(() => default)`, `?? default`, or a `try { … } catch { return neutral }` — the test coverage for that code path must do **one** of:

1. **Assert a data-level value** that the success path produces and the fallback does not. This requires a predictable non-empty upstream (e.g., a catalog endpoint that always returns rows, or seeded test data).
2. **Add a separate test that fails specifically when the upstream fails.** For UI tests, the canonical example is calling a backend health endpoint and asserting HTTP 200 (see `apps/web/e2e/staging.spec.ts` test 5 — "authenticated API call succeeds"). For controller / service unit tests, add a paired test that asserts the fallback branch with a rejected mock so success and failure paths are both exercised.
3. **Document the intentional structure-only assertion with an inline comment** that names the source file and line of the swallowed fallback and explains why a data-level assertion is not appropriate (e.g., test user has no data, fallback shape is identical to the empty success case).

A test that asserts only structure or presence — heading visible, tab visible, page renders — gives a false-green signal when paired with an error-swallowing source path: the assertion passes whether the upstream succeeded or its fallback was silently substituted.

---

## Why

PR [#346](https://github.com/merickvaughn/lifting-logbook/pull/346) introduced graceful-degradation wrappers on three Next.js Server Components (`ProgramsPage`, `HistoryPage`, `CyclePage`) without updating the staging suite. The Playwright assertions checked only structure — headings, tab elements, URL patterns — so the staging suite continued to pass even when the backend API was unreachable. The graceful degradation itself is correct product behavior (per ADR-023), but the test surface no longer distinguished success from silent failure.

This pattern can recur anywhere an error boundary returns a neutral value: empty arrays, default settings, redirects to a recovery page. The standard ensures every new occurrence is paired with a deliberate decision about test coverage.

---

## Examples

### Good: explicit success-path test

`apps/web/e2e/staging.spec.ts` test 5 calls `/api/health` directly and asserts HTTP 200, with diagnostic text differentiating 401 (auth) from 503 (API down). The test fails specifically when the upstream that the other tests rely on is broken — no fallback hides the error.

### Good: paired controller branches

`apps/api/src/programs/workouts.controller.spec.ts` exercises both the success and the fallback branches of every `.catch()` in `workouts.controller.ts`:

- `getCycleDashboard.catch(ProgramNotFoundError → cycleNum 1)` — paired success and fallback tests, plus a rethrow test for non-typed errors.
- `getWorkout.catch(WorkoutNotFoundError → [])` — paired success, fallback, and rethrow tests.
- `getSkipsForCycle.catch(_ → Set())` — paired success and fallback tests; the fallback test also asserts the error was logged.

### Bad: structure-only test against an error-swallowing source

```ts
// apps/web/app/history/page.tsx
const records = await fetchLiftRecords().catch(() => []);

// Test — passes whether records is real data OR the [] fallback
test('history page renders both tabs', async ({ page }) => {
  await page.goto('/history');
  await expect(page.getByRole('tab', { name: 'Lift History' })).toBeVisible();
});
```

When the staging test user genuinely has no records, this is acceptable **only if** the comment block above the test names the swallowed fallback location and explains why a data-level assertion is not appropriate. See the comment style in `apps/web/e2e/staging.spec.ts` tests 2–4.

---

## Enforcement

- **Static check.** The custom ESLint rule [`lifting-logbook/no-uncovered-error-fallback`](../../tools/eslint-rules/no-uncovered-error-fallback.js) runs in `npm run lint` (and therefore in CI via `turbo run lint`). It is scoped to `apps/web/app/**/*.{ts,tsx}` and `apps/api/src/**/*.ts`. For each `.catch(arrow returning a neutral default)` or `try { … } catch { redirect(…) }` it requires **one** of:
  1. A test-file comment (in `apps/web/e2e/**/*.spec.ts`, `apps/**/*.spec.ts`) that names the fallback's source location as `<path>:<line>` or `<path>:<start>-<end>` — covering option 1 or 2 above by paired data assertion or paired success-path test.
  2. An `// allow-skewed: <one-sentence reason>` comment immediately before the fallback (or before an ancestor expression / statement) — covering option 3.
  3. A `// fallback-covered-by: <path-to-spec-file>` comment pointing at the spec file that exercises both branches directly (used for controller / service specs where `<path>:<line>` references are awkward). The rule verifies the referenced file exists; it does **not** verify that the spec actually exercises both branches — that is the reviewer's responsibility.
- **Mechanism notes.**
  - **"Neutral default"** as recognised by the rule means an arrow body that returns any of: literal, array literal, object literal, identifier, or a TS type-assertion (`as T` / `<T>x`) wrapping one of those. `new Expression()` constructors (e.g., `new Set()`, `new Map()`) are intentionally **not** matched today — flag them manually during review.
  - **Ancestor-comment blast radius.** An `// allow-skewed:` or `// fallback-covered-by:` comment is honored whether it sits immediately before the fallback or before any ancestor expression / statement. A single annotation above `const [a, b] = await Promise.all([…])` therefore opts out **every** `.catch()` inside that statement. Place comments inside the array, immediately before the specific `.catch()`, when granularity matters — this is why each `.catch()` in [`workouts.controller.ts`](../../apps/api/src/programs/workouts.controller.ts) carries its own `// fallback-covered-by:` line.
  - **Cache behavior.** The reference set is built once per ESLint process; IDE / `eslint --fix --watch` workflows will not pick up newly-added test comments until the language-server restarts.
- **Reviewer checklist.** The static check guarantees the *form* of coverage. Reviewers still verify that the named test actually distinguishes success from fallback — a reference comment pointing at a test that itself only checks structure does not satisfy the spirit of the rule.
- **CLAUDE.md `## Testing` rule.** A short subsection of the project CLAUDE.md points at this standard and applies the rule at PR creation time.
- **Audit coverage.** The initial audit (issue #349) covered `apps/web` and `apps/api`. A follow-up audit for `packages/core` and `packages/types` is tracked in [#354](https://github.com/merickvaughn/lifting-logbook/issues/354). When that closes, extend the rule's `files` glob in `eslint.config.js`.

---

## References

- [Issue #349 — Audit and remediate skewed tests](https://github.com/merickvaughn/lifting-logbook/issues/349) — the audit that produced this standard
- [PR #346 — staging deploy with Playwright integration test gate](https://github.com/merickvaughn/lifting-logbook/pull/346) — the incident that surfaced the pattern, and the first explicit success-path test (test 5)
- [ADR-023 — Staging Integration Test Design](../adr/ADR-023-staging-integration-test-design.md) — Consequences section names this limitation

---

## Audit history

| Date | Scope | Findings | Issue | PR |
|---|---|---|---|---|
| 2026-05-27 | `packages/core/**`, `packages/types/**` | 4 untested or under-tested neutral-return branches in `tableToObjects`, `parseCycleDashboard`, `formatDateYYYYMMDD`, `weekTypeForDate`. All four remediated with explicit fallback-branch tests; one production-code inconsistency in `parseCycleDashboard` (silent defaults vs. sibling `parseTrainingMaxes` which throws) deferred to a follow-up issue. | [#354](https://github.com/merickvaughn/lifting-logbook/issues/354) | [#357](https://github.com/merickvaughn/lifting-logbook/pull/357) |
| 2026-09-04 | `apps/web/lib/**` | Lint scope extended: the `no-uncovered-error-fallback` rule now also covers `apps/web/lib/**/*.ts`, because the two bounded custom-lift fallbacks moved from the detail/timer pages into the shared `lib/loadWorkoutPlan.ts` loader. One pre-existing site surfaced — `preferences.ts`'s `getUserSettings().catch(() => null)` — paired with `__tests__/preferences.test.ts` (unit set / unset / fetch fails → `lbs`). | [#984](https://github.com/merickvaughn/lifting-logbook/issues/984) | (this PR) |

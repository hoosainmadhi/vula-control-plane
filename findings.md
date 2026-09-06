# Findings

Dated, verified findings that shaped the build.

## 2026-09-03 — za-pos tenant internal API does NOT exist yet

Grep across `~/apps/za-pos` for `internal`, `CONTROL_PLANE`, `configure`,
`terminal_count` finds nothing but till-session domain code. za-pos
CONTEXT.md §14 (lines 295–311) documents only the _intent_: CP owns the
terminal count per store and pushes generated terminal config (Till 1..N) to
`POST /api/internal/configure` guarded by a per-store `CONTROL_PLANE_TOKEN`;
admin password reset over the same channel. **Consequence:** this CP authors
the wire contract (CONTEXT.md "Internal API contract") and verification uses
`scripts/dev-store-stub.ts` until the tenant routes land. The tenant
workstream (za-pos: `terminals` table + internal routes + `CONTROL_PLANE_TOKEN`
env) implements to match.

## 2026-09-03 — Ports 3240/3241 allocated

PORT-REGISTRY block 3240–3249 was free (3200 OptiMED CP, 3220 Beauty CP,
3230 za-pos, row 16 next). Frontend dev port 3241 proxies `/api` → 3240.

## 2026-09-03 — House control-plane pattern verified against optimed

optimed-control-plane is the reference (19 commits, tests, eslint,
auto-migrations); beauty-control-plane is an incomplete single-commit copy
(no tests/jest/eslint). Adopted optimed conventions: jest `moduleNameMapper`
strips `.js`; lazy `getRegistryDb()` singleton with `resetRegistryDb()` for
tests; env `requireEnv` production fail-fast; asyncHandler + `{ error }`
error shape; bcrypt-hash-at-boot compare; DDL with CHECK-constrained enums.
Deliberate deviations per spec: office auth naming, `/api/stores`, no audit
table, no Coolify client.

## 2026-09-03 — Jest: `jest.mocked(fetch)` does not create a mock

`jest.mocked` is a type-level cast only; calling `.mockImplementation` on it
throws `TypeError: ... is not a function`. Real spies require
`jest.spyOn(globalThis, 'fetch')` (restored in `afterEach`). Noted for all
future suites that mock global fetch.

## 2026-09-03 — Node DOMException is not `instanceof Error`-reliable in jest

Timeout/abort handling in the store client originally gated the error-name
check behind `err instanceof Error`; a DOMException abort rejection fell
through to the "unreachable" branch. Fix: read `(err as {name?}).name`
without the instanceof gate, then fall back to `err.message`.

## 2026-09-03 — Slug regex allows trailing dashes (spec regex is literal)

Spec regex `^[a-z0-9][a-z0-9-]*$` accepts `trailing-dash-`. Tests were
initially stricter than the approved contract; aligned to the spec (leading
dash, uppercase, spaces and >40 chars remain invalid).

## 2026-09-03 — Timestamps stored as UTC (`datetime('now')`)

SQLite `datetime('now')` writes UTC ("YYYY-MM-DD HH:MM:SS"); the SPA parses
with an appended `Z` and renders local time. House-consistent with optimed.

## 2026-09-03 — Token agreement: create accepts an optional controlPlaneToken

The first boot smoke exposed an ops gap: stores are deployed with
`CONTROL_PLANE_TOKEN` already set (runbook Part A), but the create route only
generated its own token — the two could never agree, so the first push always
401'd. Resolved: `POST /api/stores` accepts an optional `controlPlaneToken`
(64 lowercase hex, must match the store's env; blank → generated). The
runbook, CONTEXT glossary and the New-store modal now carry the token through.
Generation remains the default, so the original spec behaviour is unchanged
when the field is omitted.

## 2026-09-03 — bash gotcha in smoke-test.sh

`BODY=$(req …)` runs the function in a subshell, so a `status` variable set
inside `req` never reached the caller. Rewritten with a `resp` helper that
emits `<body>\n<http-code>` and the caller splits it in the parent shell.

## 2026-09-03 — ESM: `__dirname` does not exist under tsx

`src/app.ts` used `__dirname` to locate `frontend/dist`. ts-jest's CJS
transform shims it (tests passed), but `tsx watch` runs true ESM and crashed
at boot. Fixed with `fileURLToPath(import.meta.url)`. Lesson: boot the server
(`npm run dev:api`) after ESM-sensitive edits — unit tests alone don't prove
the runtime entry works.

## 2026-09-03 — SQLite can't ALTER CHECK constraints

`last_health_status` was added to the DDL from day one, so no table rebuild
is needed (optimed had to rebuild `practices` for a CHECK change). If a
future column needs a CHECK change, mirror optimed's rebuild choreography.

## 2026-09-06 — fleet planning session (F1–F3 planned, no code)

- **Fleet state verified from the registry** (`data/control-plane.db`,
  read-only): 5 stores, all `active` / health `up` / config `ok` —
  brake-bolt-spares (spares, 3 tills), builders-hardware (hardware, 3),
  everyday-retail (general, 25), medisave-pharmacy (pharmacy, 5),
  urban-threads (clothing, 2). No gaps to register.
- **Owner decisions:** full fleet roadmap phased — F1 CP ops hardening,
  F2 Coolify auto-provisioning, F3 central office over the fleet —
  planned into the planning files now, implemented later (same pattern
  as the tenant's P1–P7 set).
- **F2 prerequisite:** vula-app.co.za is not registered yet (see
  tidbits) — the wildcard DNS must exist before auto-provisioning can
  go live; the phase is env-gated so the panel works without it.
- **F3 pulls tenant work:** internal-API v0.3.0 in ~/apps/za-pos (fleet
  summary, catalogue upsert, IBT stock in/out). The tenant repo carries
  a cross-reference in its task_plan.md so the workstream isn't lost.
- **Uncommitted tree:** frontend components + CONTEXT.md batch in this
  repo — settle before F1 starts.

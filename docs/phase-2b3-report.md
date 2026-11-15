# Phase 2B.3 — SECURITY DEFINER ownership and final migration audit: report

> **Status: complete as audit and verified preparation. No Supabase project was contacted or linked. No migration was applied to any persistent database. No commit, push or PR.**
>
> Every result below is from a disposable local PostgreSQL **17.6** cluster (Unix socket only, under `/tmp`), in-memory PGlite, or file inspection. **No hosted Supabase compatibility is claimed.**

Companion documents: [ownership matrix](phase-2b3-definer-ownership-matrix.md) · [Storage execution procedure](phase-2b3-storage-execution-procedure.md) · [migration audit](phase-2b3-migration-audit.md).

## 1. Headline finding

The Phase 2B.2 plan for definer ownership was **wrong, and would have silently broken the application.** It created `ff_migration_owner` as `NOBYPASSRLS` and `010` *asserted* that it must not have `BYPASSRLS`. Applying it would have made all ten read helpers return `false` for every legitimate user — no error, no exception, no failed test.

Two independent defects were found and fixed:

1. **`009` never granted `USAGE` on schema `auth`.** `EXECUTE` on `auth.uid()` is a different privilege. Under any re-owned definer, every helper that validates `auth.uid()` fails `permission denied for schema auth`.
2. **`NOBYPASSRLS` makes the helpers silently return `false`.** Every policy is `to authenticated`; under a definer the current role is the definer, so no policy applies, and each helper is `exists(... where user_id = auth.uid())` → zero rows → `false`. A member becomes indistinguishable from an outsider.

This is why Phase 2B.3 was right to demand measurement before bulk transfer. The proposed model is now `BYPASSRLS` on a `NOLOGIN` role that owns nothing, and `010` asserts it.

## 2. Files created / changed

### Created

| File | Purpose |
|---|---|
| `supabase/design/tests/phase2b3-ownership.test.mjs` | 23 tests: inventory, three ownership models, caller identity, membership/role revocation, cross-league isolation, `search_path` hijack, EXECUTE surface |
| `supabase/design/tests/postgres-phase2b3.mjs` | Native PG17.6 runner for the above (socket-only guard) |
| `docs/phase-2b3-definer-ownership-matrix.md` | Function-by-function matrix for all 56 |
| `docs/phase-2b3-storage-execution-procedure.md` | 3a/3b execution procedure |
| `docs/phase-2b3-migration-audit.md` | Combined 001–010 audit |
| `docs/phase-2b3-report.md` | This report |

### Changed

| File | Change |
|---|---|
| `supabase/design/migrations/009_ownership_and_grants.sql` | Role created `BYPASSRLS`; added `USAGE` on `auth`, `USAGE` on `storage`, table `DML` and sequence grants; documented why in-file |
| `supabase/design/migrations/010_privilege_verification.sql` | Now **requires** `BYPASSRLS` (was: forbade it); asserts the owner owns no `public` relation and has `USAGE` on `auth` |
| `scripts/check-migration-package.mjs` | Re-pinned 009/010 checksums (001–006 unchanged) |

**`001`–`006` remain byte-for-byte identical** — verified by checksum, and enforced by the guard.

## 3. Function-by-function ownership matrix

Full table in [the matrix document](phase-2b3-definer-ownership-matrix.md) covering all **56**. Summary:

| Property | Measured |
|---|---|
| Count | **56**, all in `ff_private` (none in exposed `public`) |
| Current owner | the migration role, **which also owns all 40 `public` tables** |
| `search_path` | pinned on **56/56**, all exactly `pg_catalog, ff_private` |
| RLS | enabled on 40/40 tables; `FORCE` on **0/40** |
| ⇒ current behaviour | every definer **bypasses RLS implicitly** by table ownership |
| Call `auth.uid()` | 28 |
| Touch schema `storage` | 0 |
| Client-executable | **10** (`authenticated`), **0** (`anon`), **0** (`PUBLIC`) |
| Trigger functions | 26 |
| Internal workflow/RPC support | 20 |

**Per-group verdict — all 56 safe for `ff_migration_owner`,** with the caveat that the *read helpers require `BYPASSRLS`*: they must read membership/roster rows the caller's own RLS would hide. The 20 internal functions and 26 triggers are safe because they are not client-executable and each mutating path re-checks caller identity itself.

## 4. Proposed ownership change

**`ff_migration_owner`**: `NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE **BYPASSRLS**`, holding `USAGE` on `public`/`ff_private`/`auth`/`storage`, `EXECUTE` on `auth.uid()`, and `SELECT, INSERT, UPDATE, DELETE` on `public` tables + `USAGE, SELECT` on sequences — **owning nothing**.

`BYPASSRLS` is deliberate and safe *here* because the role is `NOLOGIN`, is never granted to a client role (asserted), is reachable only as a definer, owns no relation so cannot run DDL on application data (asserted), and RLS still filters every direct client read (asserted).

Rejected, with reasons measured rather than argued:

| Rejected | Outcome |
|---|---|
| Keep functions owned by the table owner | Works, but posture stays implicit |
| Transfer **table** ownership to the definer | Works, but hands the definer durable DDL authority |
| `NOBYPASSRLS` + explicit grants | **All ten helpers silently `false`** |
| Bulk `ALTER FUNCTION … OWNER TO` in a migration | Not justified — 56 behaviour changes in one step |

### What was deliberately NOT done

**No ownership was transferred.** `009` now defines the role and its privileges correctly, but the `ALTER FUNCTION … OWNER TO ff_migration_owner` statements are **not written**. This is a behaviour change, not a grant: it needs per-function review with the new suite as the gate, and Phase 2B.3 was scoped to establish whether the change is safe — which it now is, with evidence. Recommended sequence in §9.

## 5. Security test evidence (23 tests, green on PGlite **and** PG17.6)

| # | Test | Proves |
|---|---|---|
| 1 | count = 56 | inventory completeness |
| 2 | all in `ff_private` | no definer in the exposed schema |
| 3 | `search_path` pinned, no mutable path | 56/56, exact value |
| 4 | RLS on all 40, `FORCE` on none | the premise of the whole analysis |
| 5 | definer owner == table owner | the implicit-bypass baseline |
| 6 | baseline helpers resolve correctly | control group |
| 7 | `USAGE` on `auth` is separate from `EXECUTE` | **defect 1**, now supplied by `009` |
| 8 | Model B: `NOBYPASSRLS` → helpers `false` | **defect 2**, the silent failure |
| 9 | outsider vs member indistinguishable under Model B | why it is dangerous |
| 10 | Model C restores baseline exactly, owns no table | the proposal is correct |
| 11 | Model C does not widen client access | RLS still filters |
| 12 | null caller identity never authorizes | `auth.uid()` null-safety |
| 13 | **membership revocation** → immediate loss of access | revocation |
| 14 | **role revocation** (leader→manager, organizer deletion) | revocation |
| 15 | cross-league isolation | no cross-tenant leak |
| 16 | mismatched `(league, match)` args → `false` | argument confusion |
| 17 | hostile schema first on session `search_path` cannot hijack | `search_path` safety |
| 18 | all 56 pin the exact path | structural |
| 19 | `anon` executes nothing | no anon exposure |
| 20 | `authenticated` executes **exactly** the 10 | no unintended exposure |
| 21 | no mutation workflow client-executable | fail-closed |
| 22 | `PUBLIC` holds no `EXECUTE` | default-open closed |
| 23 | `010` fails under `NOBYPASSRLS` | **the assertion is not decorative** |

Test 23 is the important one for durability: it proves `010` would *catch* a regression to the broken model rather than passing silently.

## 6. Storage execution procedure

`003` is frozen, so the 3a/3b split is a **procedure**, not an edit. Full detail in [the storage document](phase-2b3-storage-execution-procedure.md).

- **3a** (bucket row, `can_read_image`, grants) runs as the normal migration role. *Verified to succeed as a non-owner on PG17.6.*
- **3b** (the policy, and nothing else) runs once as `supabase_storage_admin`: `drop policy if exists` + `create policy`, `SELECT`-only. No ownership transfer, no privilege grant, no `ENABLE RLS`, no role membership — all four forbidden and why.
- **`010` fails if 3b was skipped**, which is the control that prevents shipping an unprotected bucket.

**New finding this phase — a fidelity gap:** the `setup.sql` mock creates `storage.objects` **owned by the migration role**, so `003` applies cleanly in every local test. The local suite **structurally cannot** catch the `42501` ownership failure. A green `test:db:design` run is not evidence that `003` is applicable to Supabase.

## 7. Migration audit (001–010)

Full detail in [the audit document](phase-2b3-migration-audit.md).

| Area | Finding |
|---|---|
| Clean install | `001`→`010` apply in order in **both** bootstraps, on PG17.6 |
| Dependency order | **no step has slack** — reordering any pair fails or silently weakens the state |
| Ownership | 40 tables unchanged; 56 functions pending reassignment; `storage.objects` untouched |
| RLS | 40/40 enabled, 0/40 forced, all policies `to authenticated` |
| **Rollback** | **0 down migrations**; `drop schema … cascade` works; **`001`–`008` are not idempotent** (only `009`/`010` re-run cleanly) |
| Cross-migration defects | 3 high (all fixed this phase), 3 medium fixed in 2B.2, 3 medium documented/accepted |

The lack of rollback is a genuine, documented limitation: recovery is forward-only, and `db reset` must be followed by re-running 3b.

## 8. All test results

| Gate | Result |
|---|---|
| `npm test` (unit) | **36 / 36** |
| `npm run test:db:design` (PGlite) | **65 / 65** (42 → 65) |
| `npm run typecheck` | clean |
| `npm run build` | built |
| `npm run test:pages:assets` | verified for `/Hagz-fantasy/` |
| `npm run check:migrations` | **17 / 17**; tamper test fails as designed |
| `git diff --check` | clean |
| PG17.6 `postgres-design-2a3` | 10 / 10 |
| PG17.6 `postgres-security-2a3` | 25 / 25 |
| PG17.6 `postgres-security-2a4` | 29 / 29 |
| PG17.6 `postgres-compat` | 13 / 13 |
| PG17.6 `postgres-phase2b2` | 11 / 11 |
| PG17.6 `postgres-phase2b3` (new) | **23 / 23** |
| **Native PG17.6 total** | **111 / 111** |
| Chain replay, both bootstraps | 10 / 10 files each |
| `006` pristine guard | applies on empty; refuses populated with the documented message |

## 9. Remaining blockers

**Ownership work still outstanding:**

1. **The `ALTER FUNCTION … OWNER TO ff_migration_owner` statements are unwritten.** Recommended sequence: (a) write them as `011_definer_ownership_transfer.sql` covering all 56 in one reviewed transaction; (b) run the full suite plus a workflow end-to-end pass under the new owner; (c) validate on a fresh cluster that `010` passes and every helper still returns baseline values. Not to be bundled with grant work.
2. **`003`'s 3a/3b split exists only as a procedure** — it must be materialized as an executable migration plus an operator runbook when `001`–`006` become executable.
3. **`storage.objects` has never been policy-tested on a real project**, and the mock cannot do it (§6).

**Runtime, unchanged:**

4. `READ COMMITTED` enforcement, `40P01` whole-transaction retry, and PostgREST error mapping for `23514` conflicts — no caller exists.
5. **No container runtime** here, so `supabase start` / `db reset` / `test db` are unavailable; the replay gate cannot run.
6. **No rollback path**; `001`–`008` are not idempotent. Take a verified backup and confirm the restore path before the first hosted migration.
7. **Aggregate enforcement** (squads, budgets, formations, deadlines) is unimplemented, and **money units** (×1,000,000) plus exact-numeric transport to JS are undocumented.

**Product/operational, unchanged from Phase 2A:** scoring values, event/bench/vice semantics, standings ties, correction UI, duplicate-person eligibility, role delegation, scheduling, invitations, retention, moderation, rate limits, operator recovery, image lifecycle.

**Explicitly not claimed:** hosted Supabase compatibility; Auth/PostgREST/Storage behaviour; the effect of `auto_expose_new_tables` on a real project; the 3b execution path; any concurrency behaviour.

## 10. Stop state

Stopped as instructed: **no Supabase connection**, no project link, **no migration executed against any persistent database**, **no commit, push or PR**. `001`–`006` are byte-identical; all prior commits intact on `arena/4da779c0-hagz-fantasy` at `1a78ccb`.

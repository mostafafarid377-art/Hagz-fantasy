# Phase 2B.5 — Final report

**No Supabase connection, no persistent migration, no commit, no push, no deployment.** Everything below was verified offline on disposable PostgreSQL 17.6 clusters or in-memory PGlite.

Deliverables: [ownership decisions](phase-2b5-ownership-final-decisions.md) · [storage runbook](phase-2b5-storage-final-runbook.md) · [recovery & backup](phase-2b5-recovery-and-backup.md) · [migration package](phase-2b5-migration-package.md)

## 1. Which offline blockers are resolved

| 2B.4 blocker | Status now |
|---|---|
| Definer ownership transfer unwritten | **Resolved** — `011_definer_ownership_transfer.sql`, 56 explicit `ALTER FUNCTION … OWNER TO` statements with guards and a post-condition |
| Tests missing for 7 flagged functions under the new owner | **Resolved for the transfer as a whole** — a before/after behavioural snapshot over all 10 helpers × 3 actors, plus revocation, identity, `search_path` and EXECUTE-surface cases. `can_read_image` against *real* Storage rows remains impossible offline (see §7) |
| Storage Phase B never executed; mock cannot validate it | **Partially resolved** — the step is now a runnable, idempotent, self-checking artefact with a native rehearsal of its failure mode. Still unexecuted on a project |
| `003` existed only as a frozen draft + procedure | **Resolved** — `003b_storage_policy_owner_step.sql` is a concrete, runnable file; the 3a split is documented |
| No rollback path; recovery untested | **Substantially resolved** — 7 recovery cases rehearsed on real PG17.6. The absence of down migrations is now a documented, rehearsed constraint rather than a gap |
| Runtime concerns (`READ COMMITTED`, `40P01`, PostgREST mapping) | **Unchanged — needs a real caller and a real project** |

Two defects were found and fixed during this phase, both in `009`:
1. The **first** default-privilege `DO` block was unguarded and aborted the whole migration on any cluster without a `postgres` role.
2. Same block also aborted for a deploying role that is not a member of `postgres`. Both are now guarded by an existence check **and** a membership check.

## 2. Ownership decision for all 56 functions

**All 56 → `ff_migration_owner`.** The full per-function matrix (signature, current owner, proposed owner, tables, `auth.uid()`, `BYPASSRLS`, EXECUTE, risk, tests) is in the [ownership decisions](phase-2b5-ownership-final-decisions.md) document.

| Group | Count | Decision | Why |
|---|---|---|---|
| Read helpers | 10 | Transfer | must read rows the caller's RLS hides |
| Internal workflow/RPC | 20 | Transfer | client-unreachable; validate the caller themselves |
| Trigger functions | 26 | Transfer | never called directly; derive from `NEW`/`OLD` |

### Why this is not a bulk transfer in the harmful sense

Three measurements made this a conclusion rather than a shortcut:

1. **54 of 56 functions touch a table directly.** The two that do not (`guard_standings`, `lock_roster_player`) both delegate to functions that do.
2. **Privileges are re-evaluated per function against that function's own owner.** A narrow `nobypassrls` wrapper calling a broad `bypassrls` helper saw **all** rows; the same wrapper reading directly saw **none**. So splitting owners would not reduce any privilege — only create 56 review surfaces.
3. **The current model already bypasses RLS implicitly** (definer = table owner). The transfer does not *add* a bypass; it makes the existing one explicit and **removes table ownership**, so the definer can no longer run DDL.

Net: behaviour identical, privileges reduced. That is the whole argument.

## 3. What was implemented vs deliberately deferred

**Implemented:**

- `011_definer_ownership_transfer.sql` — 56 explicit statements, guarded (role must exist, be `NOLOGIN`, have `BYPASSRLS`), with a post-condition that aborts if any function is left behind. **No grant changes** in the file, so a failure is unambiguous.
- `009` hardening (two guard fixes above).
- Ownership suite (16 cases) + native runner.
- Storage artefacts: `003b_storage_policy_owner_step.sql`, `verify_storage_setup.sql`.
- Recovery suite (7 rehearsed cases).

**Deliberately deferred:**

| Item | Why |
|---|---|
| Applying `011` to a real project | requires a Supabase connection — forbidden |
| Definer ownership for **future** functions | functions created later inherit the creating role; a standing rule + follow-up migration is required |
| Per-group owner splitting | measured to add cost without reducing privilege |
| Table ownership transfer | rejected — hands the definer DDL authority over application data |

**Nothing was left unchanged due to an unsafety blocker**: all 56 are individually justified and covered. The only genuine blocker is environmental (no Supabase project).

## 4. Exact Storage execution procedure

Full detail in the [storage runbook](phase-2b5-storage-final-runbook.md). Summary:

**Phase A — migration role** (no ownership needed; rehearsed): `INSERT` the private `player-images` bucket; `CREATE FUNCTION ff_private.can_read_image`; revoke from `public`/`anon`/`authenticated`, grant to `authenticated`. **Do not** run `ENABLE ROW LEVEL SECURITY`.

**Phase B — Storage owner only** (run `003b_storage_policy_owner_step.sql`):

```sql
select pg_get_userbyid(relowner) from pg_class where oid='storage.objects'::regclass;  -- confirm owner first
begin;
  -- refuse if storage.objects is absent
  drop policy if exists player_images_member_read on storage.objects;
  create policy player_images_member_read on storage.objects
    for select to authenticated
    using (bucket_id='player-images' and ff_private.can_read_image(name));
  -- assert: exactly one SELECT policy, zero write policies, RLS enabled
commit;
```

Never transfers ownership of `storage.objects`; never grants a privilege; never grants role membership; creates no write policy.

**Phase C — verification:** `verify_storage_setup.sql` (7 checks). Migration `010` asserts the critical subset and **fails the deployment** if Phase B was skipped.

**If a step fails:** re-run Phase B — it is idempotent. A failure leaves the bucket present with **zero policies**, which is fail-closed, never open.

## 5. Recovery and backup rehearsal results

Rehearsed on real PostgreSQL 17.6 (`phase2b5-recovery.test.mjs`, 7 cases, all pass):

| Case | Scenario | Observed |
|---|---|---|
| 1 | failure inside one transaction | **atomic** — 43 functions before and after; plain retry succeeds |
| 2 | committed-batch partial apply | blind retry fails `already exists` — never re-run |
| 3 | `009`×3, `010`×2, `011`×2 | all cleanly re-applied |
| 4 | `011` before `009` | refused `42501`, **0 functions moved** |
| 5 | split ownership (1 function off-target) | re-running `011` restored all 56 |
| 6 | failed storage policy | bucket present, **0 policies** (fail-closed), non-owner denied `must be owner` |
| 7 | `009` with no `postgres` role | applied cleanly — guard skipped the default-privilege change |

**Backup/restore: not rehearsed, and this is the biggest remaining operational gap.** There is no down migration by design, so a verified restore is the *only* production rollback — and no restore has been taken or tested. Recorded as a hard precondition in the recovery runbook §9.

## 6. Full test results

| Gate | Result |
|---|---|
| `npm test` (unit) | **36 / 36** |
| `npm run test:db:design` (PGlite) | **99 tests: 92 pass, 0 fail, 7 skipped** |
| `npm run typecheck` | clean |
| `npm run build` | built |
| `npm run test:pages:assets` | verified for `/Hagz-fantasy/` |
| `npm run check:migrations` | **18 / 18** |
| Guard tamper — altered `011` | **fails as designed** (1 failure) |
| Guard tamper — SQL in `supabase/migrations/` | **fails as designed** (2 failures) |
| `git diff --check` | clean |
| PG17.6 `postgres-design-2a3` | 10 / 10 |
| PG17.6 `postgres-security-2a3` | 25 / 25 |
| PG17.6 `postgres-security-2a4` | 29 / 29 |
| PG17.6 `postgres-compat` | 13 / 13 |
| PG17.6 `postgres-phase2b2` | 11 / 11 |
| PG17.6 `postgres-phase2b3` | 25 / 25 |
| PG17.6 `postgres-phase2b5` (new) | **16 / 16** |
| PG17.6 `phase2b5-recovery` (new) | **7 / 7** |
| **Native PG17.6 total** | **136 / 136** |
| Clean install 001→011, Supabase-like | **11 / 11 applied** |
| Clean install 001→011, mock | **11 / 11 applied** |
| End state after clean install | 40 tables · 56 definers · 56 owned by `ff_migration_owner` · **0 tables owned by it** · 40 RLS · 10 client-executable · 0 anon-executable |
| `001`–`006` byte-identical | verified against original pins |

The 7 skipped PGlite tests are the native-only recovery cases, which need a non-superuser server and a fresh cluster per case.

### Honest classification of these tests

| Kind | Which | What it proves |
|---|---|---|
| **Genuine behavioural** | ownership snapshot before/after, revocation, identity, `search_path`, EXECUTE surface, recovery cases 1–7, clean install | real PostgreSQL semantics |
| **Mocked** | everything using `setup.sql` (mock `auth.uid()`, mock roles, mock storage tables) | design consistency only |
| **Cannot validate Supabase** | all Storage cases, `auto_expose_new_tables`, PostgREST, JWT issuance, pooled concurrency | nothing about the hosted platform — and the suite says so, one test asserts the mock's ownership limitation *on purpose* |

## 7. Remaining risks requiring a real Supabase environment

1. **Everything Storage.** Whether a hosted project permits an owner-authorised one-off step, and how it is audited, is unconfirmed. Runtime behaviour (signed URLs, MIME/size, `allow_only_operation`) untested.
2. **Role inheritance and default privileges** on a real project; whether `009`'s guarded `ALTER DEFAULT PRIVILEGES` executes or skips there.
3. **`auto_expose_new_tables = false`** — set locally; the hosted effect is unverified.
4. **Backup and restore.** Never taken, never tested. This is the only production rollback.
5. **Concurrency** across pooled connections: `READ COMMITTED` enforcement and `40P01` retry have no real caller.
6. **PostgREST error mapping** for the new `23514` conflict codes.
7. **Future functions** will not inherit `ff_migration_owner`; a standing process is needed.
8. Aggregate enforcement (squads, budgets, formations, deadlines) and money-unit transport (×1,000,000 → JS) remain unimplemented.

## 8. Is the package ready for the first controlled Supabase validation?

**Yes — for a controlled validation. No — for a production push.**

The distinction matters:

- **Ready:** every offline artefact is consistent, tested on real PostgreSQL 17.6, and rehearsed against failure. The package has no known offline defect. A controlled validation (a disposable Supabase project, no real data pass `db push --dry-run` → apply → `010` → Phase B) is the correct next step and should succeed or fail loudly.
- **Not ready for production:** no verified backup/restore, Storage unexecuted, concurrency unproven, and eight product-level gaps outstanding.

Recommended first validation: disposable project → verify `010` passes → run Phase B as the storage owner → re-run `010` → confirm helpers behave with a real JWT.

## 9. Compliance confirmation

- **No Supabase connection** was made; no project was linked.
- **No migration executed against any persistent database.** All runs used disposable clusters under `/tmp/ff-pg-audit` (Unix socket, `inet_server_addr` asserted null) or in-memory PGlite.
- **No commit, push, PR, or deployment.** Branch `arena/4da779c0-hagz-fantasy` remains at `1a78ccb` with all prior work and uncommitted changes preserved.
- **`001`–`006` byte-for-byte unchanged**; verified by checksum.
- Demo mode and all frontend behaviour unchanged.
- Phase 2B.6 was not started.

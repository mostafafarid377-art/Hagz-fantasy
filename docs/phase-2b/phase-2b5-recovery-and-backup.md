# Phase 2B.5 — Recovery and backup

Recovery procedure for the migration package, **rehearsed** on disposable PostgreSQL 17.6 databases rather than reasoned about.

Every claim marked *rehearsed* comes from `supabase/design/tests/phase2b5-recovery.test.mjs`, a seven-case suite that puts a real database into each broken state and records what actually repairs it.

## 1. The one question behind every recovery decision

The Supabase CLI records applied migrations in `supabase_migrations.schema_migrations`, and `db push` applies only migrations *absent* from that table. So:

> **The question is never "did the SQL run?" but "did the history row get written?"**

| History row | Objects | State | Remedy |
|---|---|---|---|
| absent | absent | clean | apply normally |
| **absent** | **present** | **uncertain result — the dangerous case** | §6 |
| present | present | applied | nothing |
| present | absent | inconsistent (manual restore) | restore from backup |

Establish the facts before acting:

```sql
select version, name, inserted_at from supabase_migrations.schema_migrations order by version;

select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r';            -- 001: 36  | final: 40
select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='ff_private' and p.prosecdef;          -- final: 56
select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r' and c.relrowsecurity;   -- final: 40
```

## 2. Failure during each migration

| Migration | If it fails | Recovery | Rehearsed |
|---|---|---|---|
| `001` schema | nothing exists | fix, re-apply | — |
| `002` security | `001` committed, no `ff_private` | re-apply `002` | — |
| `003` storage (3a) | bucket or helper missing | re-apply the 3a half | ✓ (case 6) |
| `003b` storage policy | see §5 | re-run the owner step (idempotent) | ✓ (case 6) |
| `004` workflows | tables `scoring_run_sources`/`match_corrections` may be missing | re-apply `004` **only if** §3 confirms nothing committed | — |
| `005` concurrency | functions partially present | §3, then §4 | ✓ (cases 1, 2) |
| `006` lineage | refuses on non-empty `match_revisions` **by design** | human review; never relax the guard | ✓ (prior phase) |
| `007` correction attempts | table missing/partial | §3, then §4 | — |
| `008` fork idempotency | as `007` | §3, then §4 | — |
| `009` ownership/grants | **idempotent** | fix cause, **re-run** | ✓ (case 3) |
| `010` verification | assertion failed — the deployment is not in the reviewed state | fix the cause; do not delete the assertion | ✓ (cases 3, 7) |
| `011` ownership transfer | split ownership | **re-run `011`** (idempotent: `ALTER … OWNER` is absolute) | ✓ (cases 3, 5) |

## 3. Partial migration application

**Rehearsed, case 1.** A migration applied inside one transaction and then failing leaves **nothing behind**: `ff_private` held 43 functions before the attempt and 43 after. The clean state means a plain retry works.

**Rehearsed, case 2.** If a client commits in batches, the committed prefix persists, and a blind retry fails with `already exists` on the first object — an error that identifies only the *first* collision, not the true state.

**Procedure:**

1. Run the §1 catalog queries; compare object counts against migration boundaries (36 → 38 → 39 → 40 tables).
2. If nothing committed (counts match the previous migration): re-apply the file normally.
3. If a prefix committed: **do not re-run the file**. Either restore from backup, or for a disposable environment reset the schemas (§7).
4. If the schema is *exactly* at a migration's end state, record history instead of re-running:
   ```
   supabase migration repair --status applied <version> --remote
   ```
   then continue with the **next** migration.

## 4. Uncertain migration history

**Rehearsed, cases 4 and 5** cover the two ownership-shaped variants; the general rule is:

1. **Read before writing** (§1 queries).
2. **Classify** against §1's table.
3. Only *absent/absent* permits a normal apply; *present/present* permits nothing.
4. For *absent/present*: repair **only** if the schema exactly matches that migration's end state; otherwise restore.

**Never** use `migration repair --status reverted` to "undo" a migration whose objects still exist — that makes history lie and the next push re-runs the file against existing objects.

**Never** re-run `001`–`008` after an uncertain result. Measured: the second application fails immediately, and the message describes only the first collision.

## 5. Storage policy failure

**Rehearsed, case 6.** A failed policy step leaves the bucket **present and fail-closed**: `storage.buckets` has the row, `pg_policy` has **zero** rows, and a non-owner is denied with `must be owner of table objects`.

| Symptom | Action |
|---|---|
| `42501 must be owner` | re-run **only** `003b_storage_policy_owner_step.sql` as the owner |
| `010` fails on storage assertions | run Phase B; the assertion is working |
| crashed mid-step | re-run; the file is idempotent and wrapped in `begin/commit` |

The bucket is never left readable by a failure. Full detail in the [storage runbook](phase-2b5-storage-final-runbook.md) §5.

## 6. Function ownership failure

**Rehearsed, case 5.** A split ownership state (one function moved back) is repaired by **re-running `011`**, which is safe because `ALTER FUNCTION … OWNER TO` is absolute rather than additive. Its post-condition aborts if any function is left behind, so a partial repair cannot pass silently.

**Rehearsed, case 4.** `011` refuses to run before `009` and moves **zero** functions — the guard aborts inside the transaction.

| Symptom | Action |
|---|---|
| `ff_migration_owner does not exist; apply 009 before 011` | apply `009` first |
| `must be NOLOGIN with BYPASSRLS` | fix the role (`ALTER ROLE … BYPASSRLS`), then re-run |
| `ownership transfer incomplete: N function(s)` | re-run `011`; if it persists, a function was created after the transfer |
| `010`: `must have BYPASSRLS` | `ALTER ROLE ff_migration_owner BYPASSRLS`, then re-run `010` |

**Do not** "repair" a split by moving individual functions by hand. Re-run the reviewed file.

## 7. Grant / default-privilege failure

`009` is idempotent and is the sanctioned repair for any grant problem. **Rehearsed, case 7:** it applies cleanly on a cluster with **no `postgres` role at all**, because the default-privilege changes are guarded by an existence check *and* a membership check.

| Symptom | Action |
|---|---|
| `permission denied to change default privileges` | not a member of `postgres`; the guard skips this, so seeing it means the file predates the Phase 2B.5 fix — update it, **do not** grant membership |
| `role "postgres" does not exist` | same; fixed by the existence check in `009` |
| `010`: anon holds a privilege | re-run `009`, then `010` |
| `010`: too many client-executable functions | re-run `009`; it revokes then re-grants exactly ten |

**Never fix a grant failure by granting more.** If `010` says a role has too much, revoke.

## 8. Safe forward repair (preferred) vs reset (disposable only)

**Forward repair is the default.** Add a new reviewed migration that corrects the state. This is the only acceptable approach for anything containing real data.

**Reset is only for disposable environments:**

```sql
drop schema public cascade;
drop schema ff_private cascade;
-- and delete the matching rows from supabase_migrations.schema_migrations
```

Rehearsed as working. It is **not** a production recovery path, and it does not restore the Storage policy: `003b` is not a CLI migration, so every reset needs Phase B re-run — which `010` will catch.

**Do not invent a rollback script.** There is none in this package and one cannot be written safely: dropping tables that later migrations have populated would destroy valid data, and `004`/`007`/`008` add objects that earlier migrations depend on. A "down" script would be a data-destroying operation disguised as recovery.

## 9. Backup and restore requirements before the first cloud migration

| # | Requirement | Status |
|---|---|---|
| 1 | Take a verified backup of the target project | **not done** (no project contacted) |
| 2 | **Test the restore** — an untested backup is not a backup | **not done** |
| 3 | Record pre-migration catalog counts (§1) as the comparison baseline | procedure defined |
| 4 | Run `supabase db push --dry-run` and review the plan | available in CLI 3.1.0; not run |
| 5 | Apply in one window, `010` last; treat its failure as a stop signal | procedure defined |
| 6 | Record Phase B's exact SQL, role, timestamp and commit | procedure defined |

The package has **no down migrations** by design, so a verified restore is the *only* production rollback. Until step 2 has been performed, there is no tested rollback path at all.

## 10. Recovery decision tree

```
Something failed / is uncertain
├─ Query schema_migrations AND the catalog
│   ├─ absent history, absent objects      → apply normally
│   ├─ absent history, objects EXACT       → migration repair --status applied, then continue
│   ├─ absent history, objects PARTIAL
│   │      ├─ disposable environment       → drop schema cascade + clear history (§8)
│   │      └─ anything else                → restore from backup (§9)
│   └─ present history
│        ├─ objects present                → nothing to do
│        └─ objects absent                 → restore from backup
├─ Storage 42501 / missing policy          → re-run 003b as the owner (§5)
├─ 009 or 010 failed                       → fix cause, re-run (both idempotent) (§7)
├─ function ownership split                → re-run 011 (§6)
└─ tempted to re-run 001–008?              → STOP. §4.
```

## 11. Rehearsal results

| Case | Scenario | Observed |
|---|---|---|
| 1 | transactional failure | **atomic** — 43 functions before and after; plain retry succeeds |
| 2 | committed-batch partial apply | blind retry fails `already exists`; state must be repaired, not re-run |
| 3 | `009` ×3, `010` ×2, `011` ×2 | all applied cleanly — genuinely idempotent |
| 4 | `011` before `009` | refused `42501`, **0 functions moved** |
| 5 | split ownership (1 function off-target) | re-running `011` restored all 56 |
| 6 | failed storage policy | bucket present, **0 policies** (fail-closed), non-owner denied |
| 7 | `009` with no `postgres` role | applied cleanly — guard skipped the default-privilege change |

## 12. Not covered

- No restore has been exercised; §9 step 2 is outstanding.
- Recovery under real data volumes, concurrent traffic, or a pooled connection is untested.
- The CLI's exact per-file transaction behaviour on a hosted project was not observed. The atomicity in §3 is from a local cluster applying a file in one transaction; if the hosted path commits per statement, the partial branches of §10 apply.
- `migration repair` semantics were read from CLI 3.1.0 help output, not exercised against a project.

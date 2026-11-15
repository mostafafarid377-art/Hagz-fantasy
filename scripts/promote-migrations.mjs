#!/usr/bin/env node
/**
 * Promote the reviewed design drafts in `supabase/design/migrations/` into the
 * executable, timestamped migration package in `supabase/migrations/`.
 *
 * Why a script instead of hand-copied files:
 *   The design drafts are review artefacts and must stay byte-for-byte
 *   unchanged. Generating the executable package from them makes that
 *   relationship auditable: `npm run check:migrations` re-derives every
 *   promoted file from the pinned draft and fails if a promoted file has
 *   drifted from its source.
 *
 * Execution order is NOT lexical-by-draft-number. Three requirements drive it:
 *   * 010 (privilege verification) asserts that all 56 definer functions are
 *     owned by ff_migration_owner, so the ownership transfer (draft 011) has to
 *     run BEFORE the verification (draft 010).
 *   * Draft 014 (definer actor identity) repoints the definers off auth.uid(),
 *     because hosted Supabase cannot grant USAGE on the auth schema. Draft 010
 *     asserts that repair has happened, so 014 must also run before 010.
 *   * The application API layer (draft 012) creates the client-callable RPCs the
 *     frontend uses, and must exist before the final verification (draft 013)
 *     asserts that no over-broad EXECUTE grant slipped through.
 *
 * Executable versions in order:
 *   001-009  schema through ownership/grants
 *   010      ownership transfer      (draft 011)
 *   011      application API         (draft 012)
 *   012      definer actor identity  (draft 014)  <- forward-only repair
 *   013      privilege verification  (draft 010)
 *   014      API surface verification(draft 013)
 *
 * One draft cannot be promoted byte-for-byte, and this is deliberate:
 *   003_storage.sql ends with `create policy ... on storage.objects`. On hosted
 *   Supabase `storage.objects` is owned by `supabase_storage_admin`, which the
 *   migration role is not a member of, so that statement fails with 42501 and
 *   would roll back the bucket insert in the same transaction. The executable
 *   copy wraps exactly that one statement in an ownership guard and leaves
 *   every other byte identical (see STORAGE_GUARD_PATCH below and
 *   docs/phase-2b/phase-2b5-storage-final-runbook.md).
 *
 * Run with: npm run migrations:promote
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const designDir = path.join(root, 'supabase', 'design', 'migrations');
const outDir = path.join(root, 'supabase', 'migrations');

/**
 * The single approved deviation from a design draft.
 *
 * `create policy player_images_member_read on storage.objects for select ...`
 * becomes an ownership-guarded DO block:
 *   - if the deployer owns storage.objects, the policy is created exactly as the
 *     draft specifies (idempotent drop-then-create);
 *   - if the deployer does not own it, the attempt is skipped with a WARNING
 *     instead of aborting the whole migration transaction.
 * Skipping is fail-closed, not fail-open: no policy means no access, and the
 * final verification migration (draft 010, assertion 8) hard-fails the
 * deployment until the owner-authorised step `supabase/design/storage/
 * 003b_storage_policy_owner_step.sql` has been run.
 */
const STORAGE_POLICY_STATEMENT =
  'create policy player_images_member_read on storage.objects for select to authenticated using(bucket_id=\'player-images\' and ff_private.can_read_image(name));';

const STORAGE_GUARD_PATCH = `-- EXECUTABLE-PACKAGE DEVIATION (single approved change vs.
-- supabase/design/migrations/003_storage.sql).
--
-- The draft ends with an unguarded CREATE POLICY on storage.objects. On hosted
-- Supabase that table is owned by supabase_storage_admin, so the statement
-- raises 42501 "must be owner of table objects" and aborts the whole migration
-- transaction - taking the bucket insert above with it. Here the same policy is
-- created only when the deploying role actually owns the table; otherwise the
-- attempt is skipped with a warning.
--
-- This is fail-closed. No policy means no access. The final verification
-- migration asserts the policy exists and fails the deployment until the
-- owner-authorised step has been run:
--   supabase/design/storage/003b_storage_policy_owner_step.sql
do $$
declare v_owner text;
begin
  select pg_get_userbyid(c.relowner) into v_owner
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'storage' and c.relname = 'objects';

  if v_owner is null then
    raise exception 'storage.objects does not exist; this is not a Supabase Storage database'
      using errcode = '42P01';
  end if;

  if pg_has_role(current_user, v_owner, 'member') or current_user = v_owner then
    drop policy if exists player_images_member_read on storage.objects;
    create policy player_images_member_read on storage.objects for select to authenticated
      using(bucket_id='player-images' and ff_private.can_read_image(name));
  else
    raise warning 'storage.objects is owned by %, which the current role does not own. '
      'The player-images policy was NOT created. Run the owner-authorised step '
      'supabase/design/storage/003b_storage_policy_owner_step.sql, then re-apply. '
      'Until then the bucket is empty of policies and therefore closed to clients.', v_owner;
  end if;
end $$;`;

/** Order matters. This is the reviewed execution order. */
const PACKAGE = [
  ['20261115000001', '001_schema.sql', 'schema'],
  ['20261115000002', '002_security.sql', 'security'],
  ['20261115000003', '003_storage.sql', 'storage'],
  ['20261115000004', '004_integrity_workflows.sql', 'integrity_workflows'],
  ['20261115000005', '005_concurrency_hardening.sql', 'concurrency_hardening'],
  ['20261115000006', '006_revision_lineage.sql', 'revision_lineage'],
  ['20261115000007', '007_correction_attempts.sql', 'correction_attempts'],
  ['20261115000008', '008_result_fork_idempotency.sql', 'result_fork_idempotency'],
  ['20261115000009', '009_ownership_and_grants.sql', 'ownership_and_grants'],
  // Draft 011 before draft 010: the verification asserts the transfer happened.
  ['20261115000010', '011_definer_ownership_transfer.sql', 'definer_ownership_transfer'],
  // New in this phase: the client-callable API surface (authored source lives in
  // supabase/design/api/, not in the CLI migration directory).
  ['20261115000011', '012_application_api.sql', 'application_api'],
  // Forward-only repair, applied BEFORE the assertions that police it: the
  // definer must not depend on USAGE on the auth schema, which hosted Supabase
  // cannot grant (see the draft header). Draft 014 -> executable 012.
  //
  // The previous executable 012 (privilege verification) and 013 (API surface
  // verification) were never recorded as applied on the hosted project - both
  // are pending - so they are renumbered here rather than edited in place.
  // Already-applied migrations 001-011 keep their versions and are untouched.
  ['20261115000012', '014_definer_actor_identity.sql', 'definer_actor_identity'],
  // Draft 010: asserts the base privilege posture after the repair and API layer.
  ['20261115000013', '010_privilege_verification.sql', 'privilege_verification'],
  // Draft 013 last: asserts the API surface itself did not drift.
  ['20261115000014', '013_api_surface_verification.sql', 'api_surface_verification'],
];

/** Drafts that live in supabase/design/migrations/. */
const FROM_DESIGN = new Set(['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '014']);

/** Authored sources that live in supabase/design/api/ rather than migrations/. */
const FROM_API = new Set(['012', '013']);

/**
 * Re-derive the exact expected content of one executable migration from its
 * reviewed source. Exported so the guard can prove the committed executables
 * were not hand-edited.
 */
export async function buildExpected(name, source) {
  const draft = path.basename(source);
  const key = draft.slice(0, 3);
  let body;

  if (FROM_DESIGN.has(key)) {
    body = await readFile(path.join(designDir, draft), 'utf8');
    if (draft === '003_storage.sql') {
      if (!body.includes(STORAGE_POLICY_STATEMENT)) {
        throw new Error(
          '003_storage.sql no longer contains the expected CREATE POLICY statement; ' +
            'the approved deviation cannot be applied safely. Review the draft before promoting.',
        );
      }
      body = body.replace(STORAGE_POLICY_STATEMENT, () => STORAGE_GUARD_PATCH);
    }
  } else if (FROM_API.has(key)) {
    body = await readFile(path.join(root, 'supabase', 'design', 'api', draft), 'utf8');
  } else {
    throw new Error(`no source for ${draft}`);
  }

  const header =
    `-- Fantasy Friends executable migration ${name.replace(/\.sql$/, '')}\n` +
    `-- Generated by scripts/promote-migrations.mjs from ` +
    (FROM_DESIGN.has(key) ? `supabase/design/migrations/${draft}` : `supabase/design/api/${draft}`) +
    `\n-- Do not edit by hand: the guard re-derives this file and fails on drift.\n\n`;

  return header + body;
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const written = [];

  for (const [stamp, draft, slug] of PACKAGE) {
    const name = `${stamp}_${slug}.sql`;
    const source = FROM_DESIGN.has(draft.slice(0, 3))
      ? `design/migrations/${draft}`
      : `design/api/${draft}`;
    await writeFile(path.join(outDir, name), await buildExpected(name, source), 'utf8');
    written.push(name);
  }

  console.log(`Wrote ${written.length} migration(s) to supabase/migrations/:`);
  for (const name of written) console.log(`  ${name}`);
  console.log(
    '\nOrder note: 001-011 first, then the forward-only repair and the assertions it\n' +
      'enables: 012 definer actor identity, 013 privilege verification, and\n' +
      '014 API surface verification last. The repair must precede 013 because 013\n' +
      'asserts the repair has happened.',
  );
}

// Only promote when run directly; the guard imports buildExpected().
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}

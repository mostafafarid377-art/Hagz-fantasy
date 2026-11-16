# Live player images: security design and deployment review

## Status

This branch implements an authenticated client upload flow and a forward-only SQL design. **It has not been applied or verified on hosted Supabase.** Keep the PR in draft until the SQL, Storage permissions and hosted behavior are reviewed and tested. Applied migrations 001–015 are unchanged. The Demo continues to use IndexedDB and `local-image:` references.

## Existing configuration and cause

The private `player-images` bucket is configured for a 5 MiB limit and JPEG, PNG and WebP declared MIME types. The existing SELECT policy calls `ff_private.can_read_image` and allows league members to read referenced published player images, while suggestion images are private to their submitter and the leader. `player_profiles` and `player_suggestions` have `image_path` and `image_url`; approval copies the suggestion path to the profile. Previously live upload was explicitly blocked and views ignored `image_path`.

## New flow and policy model

- A leader first creates or edits a player; a manager first creates a suggestion. `ff_image_reserve` checks the caller against the actual target and creates a one-hour, random, immutable league-scoped path in a private reservation table. It permits a leader for a published player or the author of their own pending suggestion; other users cannot write reservations directly.
- The authenticated client validates size, declared MIME, magic bytes and browser decoding, previews the image, and uses the authenticated Storage endpoint with upload progress. Storage still enforces its bucket size and declared MIME restrictions. `ff_image_set` uses a compare-and-swap, confirms the object exists, checks reservation and authorization, and updates the record path (or explicitly clears it). Triggers prevent the old APIs from attaching arbitrary paths. Approval carries the suggestion image forward.
- `018_player_image_uploads.sql` adds the private reservations, target checks, reference guards and RPCs. The original read policy remains unchanged. Replacements use new object names; there is **no UPDATE policy** for changing existing object bytes.
- The owner-assisted step adds INSERT for an active reservation; a separate SELECT for the reservation owner to see their own staged/retired object; and DELETE only for the owner's retired, unreferenced object. No anonymous write is granted. Staged objects cannot be deleted by clients, to avoid racing an attachment. Objects created by other actors, previously referenced by suggestions, or abandoned during failure may remain as orphans and require a separately reviewed operator cleanup. Deleting a record image unlinks it immediately; physical cleanup is best effort.
- Private paths are resolved through authenticated signed URLs, refreshed before expiration. Missing/unreadable objects use the existing initials fallback. Signed URLs are bearer links until they expire, including after membership changes; do not share them.

## Storage owner-assisted step

`supabase/migrations/20261115000018_player_image_uploads.sql` is the forward-only application migration. Do not run it remotely before review. On a hosted project, `storage.objects` is generally owned by a Supabase-managed role; a normal migration role may not be able to create policies on it. **An authorized operator, acting as the actual owner of `storage.objects` and able to create functions in `storage`, must review and execute the exact SQL in `supabase/design/storage/018_image_write_owner_step.sql` after migration 018.** It leaves the original read policy intact and creates a restricted owner-executed existence helper plus the three named policies. It fails closed if RLS is disabled or the executor does not have the required ownership. It does not alter table ownership or grant a service role to the client.

Before enabling, verify there are no existing broad or conflicting INSERT, UPDATE or DELETE policies: PostgreSQL permissive policies combine with OR. Verify the bucket is private, has the 5 MiB and MIME settings above, and verify the owner/helper grants on the actual project. The helper grants only EXECUTE to the non-login `ff_migration_owner`. No hosted SQL was run.

## Security limitations requiring review

Bucket MIME enforcement checks the declared content type, which is controlled by the uploader. Client-side signature and decoding validation can be bypassed by a direct HTTP caller. The design therefore does **not** prove server-side byte-level validation or malware safety. Review a trusted server-side image validation/re-encoding pipeline before considering untrusted uploads fully safe. The Storage service's actual RLS behavior, auth headers, object metadata, owner permissions, signing, concurrent replacement/removal and expired session behavior require hosted verification; local PGlite and mocked browser/service tests do not establish these properties.

## Required hosted verification (not performed)

After approval, an authorized operator should deploy the forward-only migration and owner step using the established Supabase process, then test leader and manager success, other-manager and cross-league denial, anonymous denial, forged paths, stale writes, references surviving refresh and a second device, private signed reads, failed uploads, replacements/removal, and the project's actual bucket restrictions. No remote upload, migration, SQL execution, merge or deployment was performed by this work.

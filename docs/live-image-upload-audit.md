# Live player images: audit and remaining work

This is an **incomplete, read-only** step toward live uploads. No write policies are enabled by this change.

## Current behavior

- Demo `ImagePicker` validates and decodes files, stores blobs in IndexedDB and stores `local-image:` references in local demo state. This is intentionally browser-local.
- Live management's image picker currently validates a file for preview only. `uploadPlayerImage` is deliberately blocked. Live suggestions can submit an HTTP(S) image URL; an image file is not saved.
- `player_profiles` and `player_suggestions` each have `image_path` and `image_url`. The market, squad and suggestion RPCs return the path. Approval copies the suggestion path into the new profile. Existing live views used only `image_url`, so paths were never rendered.
- The `player-images` bucket is private, limits objects to 5 MiB and permits JPEG, PNG and WebP MIME types. `ff_private.can_read_image(name)` allows reads only for a matching league-scoped path referenced by a profile or an authorized suggestion. Paths in the existing contract are `<league UUID>/players/<object UUID>.<ext>`.
- A signed URL is needed for a private object. The read change in this branch obtains a short-lived signed URL using the authenticated client and refreshes it, while missing or forbidden objects fall back to initials.

## Why writes remain disabled

Enabling a policy on a league prefix alone would let a manager upload arbitrary player images rather than **only their own pending suggestion**, and deleting by prefix could remove an object still referenced by a player or another suggestion. The existing suggestion creation RPC accepts an `image_path` before a suggestion ID exists, and the existing player upsert uses `coalesce`, so it cannot clear an image. A safe change must coordinate object ownership, target records and lifecycle, not merely add a broad Storage policy.

The hosted `storage.objects` table may be owned by `supabase_storage_admin` rather than the migration role. The project already uses an owner-authorized manual step for its read policy; any write policy must account for that split and be tested against actual hosted permissions before deployment. Do not overwrite the existing read policy or assume the migration role can create policies on the hosted table.

## Required implementation and review

1. Add forward-only, reviewed authorization for a narrowly scoped, authenticated upload reservation tied to a specific existing player or own pending suggestion. Leaders manage published player images; managers only their own pending suggestions. Reject foreign-league IDs, forged paths, anonymous callers, and stale/approved suggestions. Control the legacy RPC image-path parameters too, so callers cannot bypass the new checks.
2. Add narrowly scoped Storage INSERT and safe orphan cleanup/DELETE rules. Enforce exact UUID path shape, bucket, role, reservation ownership and state; never allow deletion while an object is referenced. Account for Storage RLS SELECT requirements, races, cancellation and failure cleanup. Keep the current read policy intact. MIME metadata is client-controlled; 5 MiB and declared MIME restrictions alone do not establish byte-level safety. Review server-side file validation before enabling writes.
3. Provide a record update operation that explicitly replaces **or clears** `image_path` and `image_url`, with transactional authorization and concurrency checks. Ensure approval preserves the intended image and orphaned files are handled without deleting shared references.
4. Upload using the authenticated client with preview, real progress reporting, retry/error states and explicit cleanup. Resolve private paths on all surfaces, including after refresh and on another device. Test expiration and denied/missing fallbacks.
5. Exercise role/league isolation, crafted paths, unauthorized attachment/deletion, concurrent replacement, approved suggestion behavior, failure cleanup and the real Storage owner/role setup. Browser tests must cover mobile and Demo regression.

No hosted Supabase changes or hosted upload tests were performed. This audit and the signed-read work do not satisfy the requested upload definition of done.

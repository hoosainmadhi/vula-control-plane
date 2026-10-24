# Tenant App Change Workflow (za-pos)

This is the workflow for changes to the **tenant application** (the Store POS and
Head Office code in `za-pos`): new features, bug fixes, schema changes and
releases. It is separate from Control Plane code changes.

## Short version

1. Make and test the change in `za-pos`; commit it.
2. Build the Store and/or Head Office image **once** for ARM64 and publish it
   privately to GHCR. Record the manifest digest and revision.
3. Register that digest as a release in the Control Plane.
4. Apply it to a pilot demo, verify, then roll it out to the rest.
5. Promote the same digest to production after staging acceptance.

No store is rebuilt. Every tenant pulls the same image by digest.

## 1. Change and test the tenant app

- Work on a branch in `za-pos`, not directly on the deployed branch.
- Run the tenant app gates before building:
  ```bash
  npm test
  npm run test:ui
  npm run typecheck
  npm run build
  ```
- If the change includes a database schema update, update
  `release-metadata.json` so the declared Store/Head Office schema and
  compatibility range match the new code. The Control Plane refuses an upgrade
  whose schema range does not include the tenant's current database.
- If the change affects demo data structure, update the golden demo databases
  used by the nightly reset; otherwise leave them alone.

## 2. Build once and publish

Build on an ARM64 machine (the Coolify host is ARM64). Do **not** build per
store.

- Store image: the root `Dockerfile` in `za-pos`.
- Head Office image: `head-office/Dockerfile`.
- Tag the image with the release version and short commit, for example
  `v2026.10.24-<short-sha>`.
- Pass `VERSION`, `GIT_SHA` and `BUILD_DATE` build arguments. The release
  provenance check requires the image revision label and `GIT_SHA` to equal the
  commit.
- Run the image checks:
  ```bash
  scripts/check-image-secrets.sh <image>
  scripts/check-image-security.sh <image>
  ```
- Push the image privately to GHCR and record the manifest digest
  (`sha256:…`) and the full commit revision. The digest is the release identity;
  never reuse or move it.
- Publishing needs a GHCR token with write access to the package. A token with
  only `write:packages` can be denied for a package linked to a private repo;
  use a token with both `repo` and `write:packages` (or equivalent fine-grained
  package-write permission).

## 3. Register the release

In the staging Control Plane open **Releases → Publish release**, or
`POST /api/releases` with:

```json
{
  "kind": "store",
  "tag": "v2026.10.24-<short-sha>",
  "digest": "sha256:<manifest-digest>",
  "version": "v2026.10.24-<short-sha>",
  "revision": "<full-commit-sha>",
  "channel": "beta",
  "schemaVersion": 1,
  "schemaMin": 1,
  "schemaMax": 1,
  "notes": "What changed"
}
```

Use `kind: "ho"` for a Head Office image and publish the matching release. The
release is immutable. Use `beta` for staging-only first; promote the same digest
to `stable` only after acceptance.

## 4. Apply to staging

1. **Releases → Upgrade** on one pilot demo (Demo General Retail is the
   conventional pilot). Select the new release and confirm.
2. Verify on the public URL:
   - `/health` reports the exact new version and revision;
   - the demo login works;
   - sample data is present;
   - the CP fleet shows `deployment: deployed`, runtime healthy.
3. If it fails, use **Rollback** to return to the previous registered release.
   Rollback targets are derived from verified history and schema-checked.
4. Roll out the rest with **New rollout**: dry run first, then wave size 1 or
   more, stop-on-failure enabled.
5. Run the demo reset and verify the demos still restore their golden data.

## 5. Promote to production

- Register the same image digest and revision in the production CP catalog.
- Apply it to one production tenant first, verify `/health`, login and data,
  then use a wave with stop-on-failure.
- Do not build a separate production image from a different commit. The same
  reviewed digest goes to production.
- Release manager permission is required; the office email must be in
  `RELEASE_MANAGER_EMAILS`.

## 6. Control Plane changes are separate

Changes to the Control Plane itself (Clients, Quotes, Plans, Billing, Devices,
Versions, Deployments, Errors, Settings, the release controller or its UI) do
**not** need a tenant image. Use the normal branch flow:

`dev` → `staging` → `main`, deploy the CP applications, then verify `/health`
and the affected screens. No store or Head Office is rebuilt.

## Current state

- Marketing demos: ten tenants (nine Stores + Urban Threads Head Office) on
  Store/HO Release A `v2026.10.21-5781c2c`, all image-based.
- The old Dockerfile demo apps and volumes were deleted after migration.
- Legacy rehearsal Stores and Head Office remain Dockerfile; they still use the
  old path and are explicitly blocked from image changes until a blue/green
  migration.
- Release B is beta and staging-only. It is not in the production catalog.
- The nightly demo reset is independent of release upgrades; it restores the
  golden databases in `/backups/vula-app/demo-golden/`.

## Rules that prevent surprises

- Build once; never rebuild a store to apply a code change.
- Never mutate a published digest or re-push a different image under the same
  release tag.
- Test the exact digest in staging before production.
- Keep the previous release registered so rollback remains available.
- For schema changes, migrate deliberately; the CP fails closed when the
  release cannot open the tenant's current schema.
- Control Plane code and tenant images are separate releases; do not couple
  them unless the image contract actually changes.

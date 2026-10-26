# Tenant App Change Workflow (za-pos)

This is the workflow for Store POS and Head Office changes: features, bug fixes,
schema changes and releases. Control Plane code changes are separate.

## Daily workflow

```bash
cd ~/apps/za-pos
git switch dev
# change + test
npm test
npm run test:ho
npm run typecheck
npm run build
git commit -am "feat: ..."
git push origin dev
```

That is the routine action. The CI does the rest for staging:

1. tests, Head Office tests, typecheck and builds;
2. native ARM64 Store and Head Office images built **once** on
   `ubuntu-24.04-arm` (no QEMU);
3. secret and security checks on those exact images;
4. immutable images pushed to GHCR with a generated tag
   `vYYYY.MM.DD-<shortsha>`;
5. the release manifest is attached to a GitHub Release;
6. the Control Plane release endpoint registers the Store and Head Office
   releases and rolls them out to the staging demos;
7. stop-on-failure: a failed Store wave stops the rest and the previous release
   remains available for rollback.

The current staging demos and their Head Office end up on the same image digest,
with the same public URLs and databases.

## Production

Production is **not** automatic. After staging is accepted:

1. Open GitHub Actions → **Promote to Production**.
2. Enter the staging release tag twice (tag + confirmation).
3. The workflow downloads that exact manifest from the GitHub Release and calls
   the production CP with scope `production-hm-stores`.
4. It never rebuilds the images. The same digests are applied to HM Stores.
5. Stop-on-failure and the previous release are preserved.

Until that manual workflow is run, production HM Stores remains on its current
release.

## The two CP scopes

| Scope                  | Tenants                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| `staging-demos`        | every image-based Store and Head Office whose slug starts `demo-`      |
| `production-hm-stores` | every image-based Store and Head Office whose slug starts `hm-stores-` |

The CI endpoint is authenticated by a scoped machine token
(`RELEASE_CI_TOKEN` on the CP, matching `CP_STAGING_RELEASE_TOKEN` /
`CP_PRODUCTION_RELEASE_TOKEN` in GitHub). It is not an office login and cannot
touch clients, billing or settings.

## Image allowlist

The Control Plane only changes image applications whose exact Coolify UUID is
listed in `VULA_ALLOWED_APP_UUIDS`:

- staging currently lists the ten demo apps (nine Stores + Head Office);
- production currently lists the three HM Stores apps.

When a new image-based tenant is created, add its exact Coolify UUID to the
appropriate CP environment before it can receive image upgrades. This is the
one manual configuration step that remains; it is a safety boundary, not a
per-release task.

## Store identity preflight

Before changing an image, the CP compares the app's `/api/internal/status`
`storeName` with the registry name. Rename either side deliberately if a demo's
registry name and its internal name diverge. Three demo registry names were
aligned to their app names when this workflow was introduced:
`Everyday Retail`, `Demo Diner`, and `Kloof Auto Spares Jhb`.

## Schema changes

If the database schema changes:

- update `release-metadata.json` with the new schema version and compatibility
  range;
- the CP refuses an upgrade that cannot open the tenant's current schema;
- update the golden demo databases if demo data shape changes;
- test the release against a tenant before widening it.

## Manual fallback

`scripts/release-tenant.mjs` (`npm run release:tenant`) remains available for a
manual or recovery release from a downloaded manifest. It registers releases,
applies pilots, runs a dry run and wave, and verifies health. The normal path is
the automatic dev push above.

## Current state

- Staging demos: on `v2026.10.26-0c100f9`; all nine Stores + Head Office healthy,
  logins and sample data verified, nightly reset verified.
- Production HM Stores: still on `v2026.10.21-5781c2c`; promotion is waiting for
  explicit approval.
- Legacy rehearsal Stores and Head Office remain Dockerfile and are blocked from
  image changes until a blue/green migration.
- The native ARM64 CI build takes about **66 seconds** for both images and about
  **87 seconds** through publish and manifest; the staging rollout of ten tenants
  takes about **3 minutes 23 seconds**.

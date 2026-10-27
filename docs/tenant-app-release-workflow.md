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

Production is **not** automatic. On the production Control Plane open
**Releases** and use the **Production promotion** panel:

1. The panel shows the newest release that every staging demo runs, the current
   production Store and Head Office versions, runtime health, the HM Stores
   targets and how many need an update.
2. **Promote to production** opens a review of every target. The operator types
   the candidate tag to confirm; there are no digests, tags or manifest paths to
   copy by hand.
3. The backend checks the release-manager role, the staging readiness, the
   target schemas, the single-flight lock, and that the GitHub Release manifest
   still carries the exact store and HO digests staging tested. It then dispatches
   the existing `promote-production.yml` workflow with its server-held GitHub
   token. The browser never receives a GitHub credential.
4. The workflow downloads that manifest and calls the production CP with scope
   `production-hm-stores`. The same CP release engine applies the digests with
   stop-first, schema checks and stop-on-failure.
5. The panel follows the batch live (per-tenant status and errors) and links the
   GitHub run. A second promotion is refused until the first finishes.

GitHub Actions → **Promote to Production** remains available as a manual
fallback; it uses the same CI endpoint and scope. A manual CI call for a
_different_ tag is refused while an approved promotion is in flight.

Until a promotion is run, production HM Stores remains on its current release.

## The two CP scopes

| Scope                  | Tenants                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| `staging-demos`        | every image-based Store and Head Office whose slug starts `demo-`      |
| `production-hm-stores` | every image-based Store and Head Office whose slug starts `hm-stores-` |

The CI endpoint is authenticated by a scoped machine token
(`RELEASE_CI_TOKEN` on the CP, matching `CP_STAGING_RELEASE_TOKEN` /
`CP_PRODUCTION_RELEASE_TOKEN` in GitHub). It is not an office login and cannot
touch clients, billing or settings.

### Promotion configuration

Production CP:

| Variable                     | Purpose                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `STAGING_CP_URL`             | staging CP queried for the tested candidate                                                          |
| `STAGING_RELEASE_READ_TOKEN` | read token sent to staging                                                                           |
| `GITHUB_PROMOTION_TOKEN`     | server-side dispatch/manifest token (classic `repo` or fine-grained Actions: write + Contents: read) |
| `GITHUB_REPOSITORY`          | default `hoosainmadhi/vula-app`                                                                      |
| `GITHUB_PROMOTION_WORKFLOW`  | default `promote-production.yml`                                                                     |
| `GITHUB_PROMOTION_REF`       | default `main`                                                                                       |
| `PROMOTION_TIMEOUT_MINUTES`  | default `15`; frees a lock no workflow callback reaches                                              |

Staging CP: `RELEASE_READ_TOKEN` with the same value as
`STAGING_RELEASE_READ_TOKEN`. Without the GitHub token the panel shows
`github_dispatch_not_configured` and refuses to start; the manual GitHub Actions
fallback still works.

## Application trust boundary

The Control Plane may only change an image application when one of these is true:

- its exact Coolify UUID is listed in `VULA_ALLOWED_APP_UUIDS` (pre-existing or
  imported tenants); or
- it is a **CP-managed application**: a row in `managed_apps` written only after
  the CP created the app and read back its UUID, name, project, domain and
  persistent `/data` storage from Coolify.

New image-based Stores and Head Offices are registered automatically in that
second path during provisioning, so onboarding no longer requires editing
`VULA_ALLOWED_APP_UUIDS` or restarting the Control Plane. A managed row is still
checked against the live app name and project before every image change, so a
renamed or moved application is refused. Applications created outside the CP
are never trusted automatically; they still need the explicit UUID allowlist.

The current static lists remain:

- staging: the ten demo apps (nine Stores + Head Office);
- production: the three HM Stores apps (their managed rows are created if they
  are ever re-provisioned by the CP).

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
- Production HM Stores: on `v2026.10.26-0c100f9`; the manual **Promote to
  Production** workflow succeeded (88 s) and applied the same digests to Cape
  Town, Johannesburg and the Head Office. Promotion remains manual.
- The production CP **Production promotion** panel is live and reads the staging
  candidate. It currently shows 0 applications needing an update, so the Promote
  button is disabled by design. `GITHUB_PROMOTION_TOKEN` is configured (classic
  PAT, `repo` scope) and verified against the private repo, the active workflow
  and the release manifest. No rollout has been started from the panel.
- Legacy rehearsal Stores and Head Office remain Dockerfile and are blocked from
  image changes until a blue/green migration.
- The native ARM64 CI build takes about **66 seconds** for both images and about
  **87 seconds** through publish and manifest; the staging rollout of ten tenants
  takes about **3 minutes 23 seconds**.

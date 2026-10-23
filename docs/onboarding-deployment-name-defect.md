# Onboarding API Defect: deploymentName Is Dropped

**Status:** open — must be fixed and tested before general customer onboarding.
Stage A accepts the existing Store through naming amendment 1; this document
records the defect separately.

## Symptom

`POST /api/clients` accepts a nested Store `deploymentName`, but the provisioned
Coolify app uses the fallback company/store name instead. In Stage A:

- requested `deploymentName`: `m4-store-a`
- expected app name: `za-pos-m4-store-a`
- actual app name: `za-pos-m4-staging-client-m4-store-a`
- fallback used: `${company.slug}-${store.name}`

The Store is healthy and its UUID/domain/digest/storage/registry are verified;
the defect is the loss of the caller's naming intent.

## Evidence in deployed commit `9ae7fc5`

- `src/services/clientOrchestrator.ts`, `orchestrateClientDeployment()`: the
  `store_deploy_*` step metadata includes name, slug, base URL, terminal counts
  and admin email, but **not** `deploymentName`.
- `src/services/clientOrchestrator.ts`, `runJobSteps()`: the `createStore()`
  call in the Store deployment step does **not** pass `deploymentName`.
- Consequently `stores.deployment_name` is null, and the image deployment path
  uses `store.deployment_name ?? `${company.slug}-${store.name}``.

The staging guard correctly enforced project/server/destination, staging name
prefix and domain. Its name check is intentionally a prefix/domain guard, not an
exact per-tenant name prediction; the plan's exact-name gate caught the
difference.

## Required fix

1. Include `deploymentName` in the `store_deploy_*` step metadata.
2. Pass it through to `createStore()` in `runJobSteps`.
3. Add a regression test that onboards a Store with
   `deploymentName: "m4-store-a"` and asserts:
   - the Store row stores it;
   - the Coolify app name is `za-pos-m4-store-a`;
   - the volume remains `vula-store-m4-store-a-sqlite-db`.
4. Run the affected onboarding/orchestration suites and typecheck.
5. Deploy only after review; do not rename existing apps or edit registry
   identity by hand.

## Scope

This is a naming-semantics defect, not a Stage A safety failure after amendment.
It does not affect existing tenants until a new onboarding uses the same path.
Stage B and fleet migration remain out of scope.

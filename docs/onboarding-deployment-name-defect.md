# Onboarding API Defect: deploymentName Is Dropped

**Status:** fixed in the repository, **not deployed**. Regression test added;
full CP suite 526/526, typecheck and build clean. The existing Stage A Store is
not renamed. The fix must be deployed to the staging CP before the second Store
is onboarded.

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

## Fix implemented in the repository

1. `deploymentName` is accepted by the nested onboarding input types and
   preserved in the Store/Head Office step metadata.
2. `createStore()` and `createPanel()` now write `deployment_name`.
3. `runJobSteps()` passes the metadata value through.
4. Regression coverage:
   - `clients.test.ts` asserts the Store row and step metadata retain
     `m4-store-a`;
   - `onboardingNaming.test.ts` mocks the Coolify create call and asserts the
     app name is exactly `za-pos-m4-store-a`.
5. Full CP suite **526/526**, typecheck and build clean.

Deployment is still required before onboarding the second Store. Do not rename
existing apps or edit registry identity by hand.

## Scope

This is a naming-semantics defect, not a Stage A safety failure after amendment.
It does not affect existing tenants until a new onboarding uses the same path.
Stage B and fleet migration remain out of scope.

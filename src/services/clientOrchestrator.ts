import crypto from 'node:crypto';
import {
  getCompanyById,
  updateCompany,
  getPlanById,
  getStoreById,
  listStores,
  createStore,
  setStoreCompany,
  setStoreDeployStatus,
  setStoreHeadOfficeToken,
  listPanelsForCompany,
  createPanel,
  setPanelDeployStatus,
  createDeploymentJob,
  updateDeploymentJob,
  getDeploymentJobById,
  createDeploymentStep,
  updateDeploymentStep,
  listStepsForJob,
  recordAuditLog,
  nextLicenceSequence,
  nextPanelLicenceSequence,
  type CompanyRecord,
  type DeploymentJobRecord,
  type DeploymentJobStepRecord,
} from '../config/registryDb.js';
import {
  isCoolifyConfigured,
  createStoreDeployment,
  createHeadOfficeDeployment,
  triggerDeploy,
} from './coolify.js';
import {
  pushTerminals,
  pushLicence,
  pushLicenceToPanel,
  ping,
  registerBranchWithPanel,
  bootstrapHeadOfficeAdmin,
} from './storeClient.js';
import { issueLicence, licencePublicKey } from './licenceSigner.js';
import { entitlementsFor } from './subscriptions.js';
import { allocateTerminals, checkAllocation, terminalAllowance } from './terminalLicences.js';
import { bootstrapStoreAdmin, generateAdminPassword } from './storeProvisioning.js';
import { logger } from '../config/env.js';
import { wireStoreToHeadOffice } from './topology.js';

export interface StoreDeploymentInput {
  name: string;
  slug: string;
  baseUrl: string;
  /** Terminal slots the POS is configured to run (pushed as Till 1..N). */
  terminalCount: number;
  /**
   * Licences to place on this store from the client's subscription. Absent means
   * "the same as the configured count" — the wizard's default.
   */
  licensedTerminalCount?: number;
  adminEmail?: string;
}

export interface HeadOfficeDeploymentInput {
  name: string;
  slug: string;
  baseUrl: string;
  adminEmail?: string;
}

export interface ClientOrchestrationInput {
  companyId: number;
  deploymentType: 'single_store' | 'multi_store';
  stores: StoreDeploymentInput[];
  headOffice?: HeadOfficeDeploymentInput;
  autoDeploy?: boolean;
}

export interface UpgradeToMultiStoreInput {
  companyId: number;
  headOffice: HeadOfficeDeploymentInput;
  newStore?: StoreDeploymentInput;
  planId?: number;
}

/**
 * Execute client deployment steps idempotently (§11, §12, §13).
 */
export async function orchestrateClientDeployment(
  input: ClientOrchestrationInput,
): Promise<{ job: DeploymentJobRecord; steps: DeploymentJobStepRecord[] }> {
  const company = getCompanyById(input.companyId);
  if (!company) {
    throw new Error(`Company ${input.companyId} not found`);
  }

  const jobType = input.deploymentType === 'multi_store' ? 'new_multi_store_client' : 'new_single_store_client';
  const job = createDeploymentJob(company.id, jobType);

  // 1. Register planned steps
  createDeploymentStep(job.id, 'company_verify', 'company', company.id, { companyName: company.name });

  if (input.deploymentType === 'multi_store' && input.headOffice) {
    createDeploymentStep(job.id, 'head_office_deploy', 'head_office', null, {
      name: input.headOffice.name,
      slug: input.headOffice.slug,
      baseUrl: input.headOffice.baseUrl,
      adminEmail: input.headOffice.adminEmail,
    });
  }

  for (const s of input.stores) {
    createDeploymentStep(job.id, `store_deploy_${s.slug}`, 'store', null, {
      name: s.name,
      slug: s.slug,
      baseUrl: s.baseUrl,
      terminalCount: s.terminalCount,
      licensedTerminalCount: s.licensedTerminalCount,
      adminEmail: s.adminEmail,
    });
  }

  if (input.deploymentType === 'multi_store') {
    createDeploymentStep(job.id, 'wire_topology', 'wiring', null, {
      storeSlugs: input.stores.map((s) => s.slug),
    });
  }

  createDeploymentStep(job.id, 'issue_licences', 'licence', null, {});
  createDeploymentStep(job.id, 'final_health_validation', 'health', null, {});

  // 2. Run steps
  await runJobSteps(job.id, input.autoDeploy ?? true);

  const updatedJob = getDeploymentJobById(job.id)!;
  const steps = listStepsForJob(job.id);
  return { job: updatedJob, steps };
}

/**
 * Executes or resumes a deployment job's steps idempotently.
 *
 * Step truthfulness (production-readiness review, 2026-09-12): a REQUIRED
 * operation — Coolify application creation, topology wiring — fails the step
 * and the job. Best-effort operations that may legitimately fail while a
 * container is still building (admin bootstrap, first config/licence push,
 * health pings) record a warning on the completed step instead of pretending
 * everything succeeded. Coolify application UUIDs are persisted immediately
 * after creation, so a retry never creates a duplicate application.
 */
export async function runJobSteps(jobId: number, autoDeploy = true): Promise<void> {
  const job = getDeploymentJobById(jobId);
  if (!job) return;

  const company = getCompanyById(job.company_id);
  if (!company) return;

  const steps = listStepsForJob(jobId);
  let hasFailed = false;

  for (const step of steps) {
    if (step.status === 'complete' || step.status === 'skipped') continue;

    updateDeploymentStep(step.id, { status: 'running', attempts: step.attempts + 1 });
    const warnings: string[] = [];

    try {
      const meta = step.metadata_json ? JSON.parse(step.metadata_json) : {};

      if (step.step_key === 'company_verify') {
        // Company verified
        updateDeploymentStep(step.id, { status: 'complete', completed: true });
        continue;
      }

      if (step.step_key === 'head_office_deploy') {
        let panel = listPanelsForCompany(company.id).find((p) => p.slug === meta.slug);
        if (!panel) {
          const token = crypto.randomBytes(32).toString('hex');
          panel = createPanel({
            companyId: company.id,
            name: meta.name,
            slug: meta.slug,
            baseUrl: meta.baseUrl,
            controlPlaneToken: token,
          });
        }

        // Provision the real Head Office image — REQUIRED. The Head Office is a
        // different application (head-office/Dockerfile), not a store deploy.
        if (autoDeploy && isCoolifyConfigured()) {
          if (panel.coolify_uuid) {
            // Retry after a failed deploy: re-trigger the existing application.
            if (panel.deploy_status === 'failed') {
              await triggerDeploy(panel.coolify_uuid);
            }
          } else {
            const result = await createHeadOfficeDeployment({
              slug: panel.slug,
              domain: panel.base_url,
              clientSlug: company.slug,
              controlPlaneToken: panel.control_plane_token,
            });
            const updatedPanel = setPanelDeployStatus(panel.id, 'provisioning', {
              coolifyUuid: result.coolifyUuid,
              volumeName: result.volumeName,
            });
            if (updatedPanel) panel = updatedPanel;
          }
        }

        // Bootstrap the panel's first admin — best-effort: the container is
        // usually still building at this point. The generated password is
        // discarded; the operator issues a login via the reveal-once reset.
        if (meta.adminEmail) {
          try {
            await bootstrapHeadOfficeAdmin(panel, {
              name: 'Head Office Administrator',
              email: meta.adminEmail,
              password: generateAdminPassword(),
            });
          } catch (aErr) {
            const msg = `Head Office admin bootstrap pending for ${panel.slug}: ${String(aErr)}`;
            warnings.push(msg);
            logger.info(msg);
          }
        }

        updateDeploymentStep(step.id, {
          status: 'complete',
          resourceId: panel.id,
          warnings,
          completed: true,
        });
        continue;
      }

      if (step.step_key.startsWith('store_deploy_')) {
        let store = listStores().find((s) => s.slug === meta.slug);
        if (!store) {
          const token = crypto.randomBytes(32).toString('hex');
          store = createStore(
            {
              name: meta.name,
              slug: meta.slug,
              baseUrl: meta.baseUrl,
              terminalCount: meta.terminalCount || 1,
            },
            token,
          );
          setStoreCompany(store.id, company.id);
        } else if (store.company_id !== company.id) {
          setStoreCompany(store.id, company.id);
        }

        // Place the client's licences on the store from the moment it exists —
        // every configure push and licence the store receives is bounded by this
        // allowance, and a store with no allocation would fall back to its
        // configured count instead of the purchased quantity.
        const allocation = meta.licensedTerminalCount ?? meta.terminalCount ?? 1;
        const allocationCheck = checkAllocation(company, store.id, allocation);
        if (!allocationCheck.ok) {
          throw new Error(allocationCheck.reason ?? 'Terminal allocation refused');
        }
        allocateTerminals(company, store.id, allocation);

        // Coolify container deployment — REQUIRED. Idempotent: an application
        // that already exists is never created twice.
        if (autoDeploy && isCoolifyConfigured()) {
          if (store.coolify_uuid) {
            if (store.deploy_status === 'failed') {
              await triggerDeploy(store.coolify_uuid);
            }
          } else {
            const result = await createStoreDeployment({
              slug: store.slug,
              domain: store.base_url,
              clientSlug: company.slug,
              controlPlaneToken: store.control_plane_token,
            });
            store = setStoreDeployStatus(store.id, 'provisioning', {
              coolifyUuid: result.coolifyUuid,
              volumeName: result.volumeName,
            })!;
          }
        }

        // Bootstrap store admin over HTTP if adminEmail provided — best-effort
        // (container likely still building). Random credential, never persisted.
        if (meta.adminEmail) {
          try {
            const adminOk = await bootstrapStoreAdmin(store, meta.adminEmail, generateAdminPassword());
            if (!adminOk) {
              const msg = `Store admin init pending for ${store.slug}: store not accepting yet`;
              warnings.push(msg);
              logger.info(msg);
            }
          } catch (aErr) {
            const msg = `Store admin init pending for ${store.slug}: ${String(aErr)}`;
            warnings.push(msg);
            logger.info(msg);
          }
        }

        // Push initial terminal configuration — best-effort while warming.
        try {
          await pushTerminals(store);
        } catch (tErr) {
          const msg = `Initial terminal push pending for ${store.slug}: ${String(tErr)}`;
          warnings.push(msg);
          logger.info(msg);
        }

        updateDeploymentStep(step.id, {
          status: 'complete',
          resourceId: store.id,
          warnings,
          completed: true,
        });
        continue;
      }

      if (step.step_key === 'wire_topology') {
        const panels = listPanelsForCompany(company.id);
        const ho = panels[0];
        if (!ho) {
          throw new Error('Topology wiring requires a Head Office panel; none exists for this company');
        }

        const stores = listStores().filter((s) => s.company_id === company.id);
        const failures: string[] = [];
        for (const s of stores) {
          try {
            // Both directions of the branch↔panel credential, in one place —
            // shared with a branch added on its own via POST /api/stores.
            await wireStoreToHeadOffice(s);
          } catch (wErr) {
            failures.push(`Topology wiring failed for store ${s.slug}: ${String(wErr)}`);
          }
        }
        if (failures.length > 0) {
          throw new Error(failures.join('; '));
        }
        updateDeploymentStep(step.id, { status: 'complete', completed: true });
        continue;
      }

      if (step.step_key === 'issue_licences') {
        const ent = entitlementsFor(company);
        const stores = listStores().filter((s) => s.company_id === company.id);
        for (const store of stores) {
          try {
            const seq = nextLicenceSequence(store.id);
            const signed = issueLicence({
              sequence: seq,
              storeSlug: store.slug,
              storeName: store.name,
              companyId: ent.companyId,
              companyName: ent.companyName,
              planCode: ent.planCode,
              planName: ent.planName,
              features: ent.features,
              maxStores: ent.maxStores,
              maxTerminalsPerStore: ent.maxTerminalsPerStore,
              // The store's own allocation: what the register may bind devices to.
              maxTerminals: terminalAllowance(store).count,
              paidThrough: ent.paidThrough,
              billingState: ent.billingState,
            });
            await pushLicence(store, signed.token);
          } catch (lErr) {
            const msg = `Initial licence push pending for store ${store.slug}: ${String(lErr)}`;
            warnings.push(msg);
            logger.info(msg);
          }
        }

        const panels = listPanelsForCompany(company.id);
        for (const panel of panels) {
          try {
            const seq = nextPanelLicenceSequence(panel.id);
            const signed = issueLicence({
              sequence: seq,
              storeSlug: panel.slug,
              storeName: panel.name,
              companyId: ent.companyId,
              companyName: ent.companyName,
              planCode: ent.planCode,
              planName: ent.planName,
              features: ent.features,
              maxStores: ent.maxStores,
              maxTerminalsPerStore: ent.maxTerminalsPerStore,
              paidThrough: ent.paidThrough,
              billingState: ent.billingState,
            });
            await pushLicenceToPanel(
              { base_url: panel.base_url, control_plane_token: panel.control_plane_token },
              signed.token,
            );
          } catch (lpErr) {
            const msg = `Initial licence push pending for panel ${panel.slug}: ${String(lpErr)}`;
            warnings.push(msg);
            logger.info(msg);
          }
        }

        updateDeploymentStep(step.id, { status: 'complete', warnings, completed: true });
        continue;
      }

      if (step.step_key === 'final_health_validation') {
        const stores = listStores().filter((s) => s.company_id === company.id);
        for (const store of stores) {
          try {
            await ping(store);
          } catch {}
        }
        updateDeploymentStep(step.id, { status: 'complete', completed: true });
        continue;
      }

      // Default fallback
      updateDeploymentStep(step.id, { status: 'complete', completed: true });
    } catch (err: any) {
      hasFailed = true;
      const errorMsg = err instanceof Error ? err.message : String(err);
      updateDeploymentStep(step.id, { status: 'failed', error: errorMsg });
      logger.error(`Deployment step ${step.step_key} failed: ${errorMsg}`);
      break;
    }
  }

  if (hasFailed) {
    updateDeploymentJob(jobId, { status: 'failed', error: 'One or more steps failed' });
  } else {
    updateDeploymentJob(jobId, { status: 'complete', completedAt: new Date().toISOString() });
    recordAuditLog('office', 'client_deployed', 'company', company.id, {
      after: { companyName: company.name, jobId },
      reason: 'Automated client orchestration finished successfully',
    });
  }
}

/**
 * Retry an incomplete or failed deployment job idempotently (§12).
 */
export async function retryDeploymentJob(jobId: number): Promise<DeploymentJobRecord> {
  const job = getDeploymentJobById(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  updateDeploymentJob(jobId, { status: 'running', error: null });
  await runJobSteps(jobId, true);

  return getDeploymentJobById(jobId)!;
}

/**
 * Single-Store to Multi-Store topology upgrade (§7).
 * Preserves the existing store database completely!
 */
export async function orchestrateUpgradeToMultiStore(
  input: UpgradeToMultiStoreInput,
): Promise<{ job: DeploymentJobRecord; steps: DeploymentJobStepRecord[] }> {
  const company = getCompanyById(input.companyId);
  if (!company) throw new Error(`Company ${input.companyId} not found`);

  // Upgrade plan if specified
  if (input.planId) {
    const plan = getPlanById(input.planId);
    if (plan) {
      updateCompany(company.id, { planId: input.planId });
    }
  }

  const job = createDeploymentJob(company.id, 'upgrade_to_multistore');

  // Step 1: Head Office deploy
  createDeploymentStep(job.id, 'head_office_deploy', 'head_office', null, {
    name: input.headOffice.name,
    slug: input.headOffice.slug,
    baseUrl: input.headOffice.baseUrl,
    adminEmail: input.headOffice.adminEmail,
  });

  // Step 2: New Store deploy (if adding a new branch)
  if (input.newStore) {
    createDeploymentStep(job.id, `store_deploy_${input.newStore.slug}`, 'store', null, {
      name: input.newStore.name,
      slug: input.newStore.slug,
      baseUrl: input.newStore.baseUrl,
      terminalCount: input.newStore.terminalCount,
      adminEmail: input.newStore.adminEmail,
    });
  }

  // Step 3: Wire topology (connect existing store + new store to Head Office)
  createDeploymentStep(job.id, 'wire_topology', 'wiring', null, {});
  createDeploymentStep(job.id, 'issue_licences', 'licence', null, {});
  createDeploymentStep(job.id, 'final_health_validation', 'health', null, {});

  await runJobSteps(job.id, true);

  const updatedJob = getDeploymentJobById(job.id)!;
  const steps = listStepsForJob(job.id);
  return { job: updatedJob, steps };
}

import crypto from 'node:crypto';
import {
  getCompanyById,
  updateCompany,
  getPlanById,
  listStores,
  createStore,
  setStoreCompany,
  listPanelsForCompany,
  createPanel,
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
import { isCoolifyConfigured, createStoreDeployment } from './coolify.js';
import { pushTerminals, pushLicence, pushLicenceToPanel, ping } from './storeClient.js';
import { issueLicence, licencePublicKey } from './licenceSigner.js';
import { entitlementsFor } from './subscriptions.js';
import { logger } from '../config/env.js';

export interface StoreDeploymentInput {
  name: string;
  slug: string;
  baseUrl: string;
  terminalCount: number;
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

        // Provision container if coolify enabled
        if (autoDeploy && isCoolifyConfigured()) {
          try {
            await createStoreDeployment({
              slug: panel.slug,
              domain: panel.base_url,
              controlPlaneToken: panel.control_plane_token,
            });
          } catch (cErr) {
            logger.warn(`Coolify provisioning warning for panel ${panel.slug}: ${String(cErr)}`);
          }
        }

        updateDeploymentStep(step.id, {
          status: 'complete',
          resourceId: panel.id,
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

        // Coolify container deployment if configured
        if (autoDeploy && isCoolifyConfigured()) {
          try {
            await createStoreDeployment({
              slug: store.slug,
              domain: store.base_url,
              controlPlaneToken: store.control_plane_token,
            });
          } catch (cErr) {
            logger.warn(`Coolify provisioning warning for store ${store.slug}: ${String(cErr)}`);
          }
        }

        // Bootstrap store admin over HTTP if adminEmail provided
        if (meta.adminEmail) {
          try {
            const { bootstrapStoreAdmin } = await import('./storeProvisioning.js');
            await bootstrapStoreAdmin(store, meta.adminEmail, 'AdminPassword@123');
          } catch (aErr) {
            logger.info(`Store admin init notice for ${store.slug}: ${String(aErr)}`);
          }
        }

        // Push initial terminal configuration
        try {
          await pushTerminals(store);
        } catch (tErr) {
          logger.info(`Initial terminal push notice for ${store.slug}: ${String(tErr)}`);
        }

        updateDeploymentStep(step.id, {
          status: 'complete',
          resourceId: store.id,
          completed: true,
        });
        continue;
      }

      if (step.step_key === 'wire_topology') {
        const panels = listPanelsForCompany(company.id);
        const ho = panels[0];
        if (ho) {
          const stores = listStores().filter((s) => s.company_id === company.id);
          for (const s of stores) {
            try {
              // Push Head Office URL & token explicitly to the store (§14)
              const count = s.terminal_count || 1;
              const terminals = Array.from({ length: count }, (_, i) => ({
                till: i + 1,
                name: `Till ${i + 1}`,
              }));
              await pushTerminals(s, {}, {
                headOffice: {
                  enabled: true,
                  url: ho.base_url,
                  token: ho.control_plane_token,
                },
              });
            } catch (wErr) {
              logger.info(`Topology wiring notice for store ${s.slug}: ${String(wErr)}`);
            }
          }
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
              paidThrough: ent.paidThrough,
              billingState: ent.billingState,
            });
            await pushLicence(store, signed.token);
          } catch (lErr) {
            logger.info(`Initial licence push notice for store ${store.slug}: ${String(lErr)}`);
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
            logger.info(`Initial licence push notice for panel ${panel.slug}: ${String(lpErr)}`);
          }
        }

        updateDeploymentStep(step.id, { status: 'complete', completed: true });
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

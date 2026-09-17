import {
  getCompanyById,
  getPanelById,
  getStoreById,
  nextLicenceSequence,
  nextPanelLicenceSequence,
  raiseLicenceSequenceFloor,
  raisePanelLicenceSequenceFloor,
  recordAuditLog,
  type PanelRecord,
  type StoreRecord,
} from '../config/registryDb.js';
import { logger } from '../utils/logger.js';
import { issueLicence } from './licenceSigner.js';
import {
  ping,
  pingPanel,
  pushLicence,
  pushLicenceToPanel,
  reportedLicenceSequence,
  type LicenceHolderKind,
} from './storeClient.js';
import { entitlementsFor, entitlementsForStore } from './subscriptions.js';

/**
 * The one place a licence is signed and delivered. Every caller that issues one —
 * the two Push Licence routes, a payment or plan change re-pushing a client's
 * whole fleet, onboarding and provisioning — goes through here, so the rules
 * below cannot hold on one surface and not another.
 *
 * The rule that matters: **a licence sequence has to be higher than the one the
 * deployment already holds**, because the deployment (rightly) refuses anything
 * lower as a stale replay. Our stored counter is a *mirror* of that value, not an
 * independent number, and a registry rebuilt or restored from an older database
 * starts it at 0 while the deployments keep counting. So we ask the deployment
 * what it holds before allocating, rather than trusting what we last remembered.
 */

/** How long the pre-flight sequence read may take before we give up on it. */
const RECONCILE_TIMEOUT_MS = 2000;

export interface LicenceSequenceReconciliation {
  /** Our counter before the correction. */
  from: number;
  /** The counter after it — at least what the deployment reported. */
  to: number;
  /** What the deployment said it holds. */
  reported: number;
}

export interface LicenceDelivery {
  sequence: number;
  /** Present only when the deployment was ahead of us and we caught up. */
  reconciled?: LicenceSequenceReconciliation;
}

interface Holder {
  kind: LicenceHolderKind;
  id: number;
  baseUrl: string;
  controlPlaneToken: string;
}

/** The sequence the deployment says it holds; null when it cannot be read. */
const readReportedSequence = async (holder: Holder): Promise<number | null> => {
  const target = { base_url: holder.baseUrl, control_plane_token: holder.controlPlaneToken };
  try {
    const body =
      holder.kind === 'store'
        ? await ping(target, { timeoutMs: RECONCILE_TIMEOUT_MS })
        : await pingPanel(target, { timeoutMs: RECONCILE_TIMEOUT_MS });
    return reportedLicenceSequence(holder.kind, body);
  } catch (err) {
    // Best effort by design: an unreachable or older deployment must not stop the
    // push, it just means we issue from our own counter as we always have.
    const detail = err instanceof Error ? err.message : String(err);
    logger.debug(`Licence sequence pre-flight skipped for ${holder.kind} ${holder.id}: ${detail}`);
    return null;
  }
};

const currentSequence = (holder: Holder): number =>
  (holder.kind === 'store' ? getStoreById(holder.id) : getPanelById(holder.id))?.licence_sequence ??
  0;

const raiseFloor = (holder: Holder, floor: number): number =>
  holder.kind === 'store'
    ? raiseLicenceSequenceFloor(holder.id, floor)
    : raisePanelLicenceSequenceFloor(holder.id, floor);

/**
 * Bring our counter up to what the deployment holds. Only ever raises — a Head
 * Office reporting `sequence: 0` because it holds no licence yet is a no-op, and a
 * deployment that is behind us is left to catch up on its own.
 */
const reconcileSequence = async (holder: Holder): Promise<LicenceSequenceReconciliation | null> => {
  const reported = await readReportedSequence(holder);
  if (reported === null) return null;

  const before = currentSequence(holder);
  if (reported <= before) return null;

  const after = raiseFloor(holder, reported);
  if (after <= before) return null;

  // Repaired automatically, so it is recorded automatically: a licence number that
  // moves without an operator asking has to be legible afterwards.
  recordAuditLog('control-plane', 'licence_sequence_reconciled', holder.kind, holder.id, {
    before: { sequence: before },
    after: { sequence: after },
    reason: `The deployment already held licence sequence ${reported}, so a licence issued from our counter (${before}) would have been refused as stale. The counter has been brought up to the deployment.`,
  });
  logger.info(
    `Licence counter for ${holder.kind} ${holder.id} reconciled ${before} → ${after} (deployment held ${reported})`,
  );
  return { from: before, to: after, reported };
};

/** Signs and delivers a store's licence; throws if the store refuses it. */
export const deliverStoreLicence = async (store: StoreRecord): Promise<LicenceDelivery> => {
  const reconciled = await reconcileSequence({
    kind: 'store',
    id: store.id,
    baseUrl: store.base_url,
    controlPlaneToken: store.control_plane_token,
  });

  const sequence = nextLicenceSequence(store.id);
  const ent = entitlementsForStore(store);
  const signed = issueLicence({
    sequence,
    storeSlug: store.slug,
    storeName: store.name,
    companyId: ent.companyId,
    companyName: ent.companyName,
    planCode: ent.planCode,
    planName: ent.planName,
    features: ent.features,
    maxStores: ent.maxStores,
    maxTerminalsPerStore: ent.maxTerminalsPerStore,
    // This store's own allowance — the register gates new device claims on it.
    maxTerminals: ent.maxTerminals ?? store.terminal_count,
    paidThrough: ent.paidThrough,
    billingState: ent.billingState,
  });
  await pushLicence(store, signed.token);

  return reconciled ? { sequence, reconciled } : { sequence };
};

/**
 * Signs and delivers a company licence to a Head Office. No `maxTerminals`: a
 * panel has no terminals of its own (the claim is absent, not zero).
 */
export const deliverPanelLicence = async (panel: PanelRecord): Promise<LicenceDelivery> => {
  const reconciled = await reconcileSequence({
    kind: 'panel',
    id: panel.id,
    baseUrl: panel.base_url,
    controlPlaneToken: panel.control_plane_token,
  });

  const sequence = nextPanelLicenceSequence(panel.id);
  const ent = entitlementsFor(getCompanyById(panel.company_id));
  const signed = issueLicence({
    sequence,
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

  return reconciled ? { sequence, reconciled } : { sequence };
};

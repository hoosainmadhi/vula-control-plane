import crypto from 'crypto';
import {
  listPanelsForCompany,
  setStoreHeadOfficeToken,
  type StoreRecord,
} from '../config/registryDb.js';
import { pushTerminals, registerBranchWithPanel } from './storeClient.js';

export type WiringOutcome = 'wired' | 'no-panel';

/**
 * Pair a branch with its merchant's Head Office — both directions, with the same
 * credential:
 *
 *  1. tell the branch which Head Office it belongs to, and with which token
 *     (`headOffice: { enabled, url, token }` on the configure push, which lands
 *     in the store's settings);
 *  2. register the branch on that Head Office's roster, presenting the same
 *     token.
 *
 * Skipping either direction leaves a panel reporting a perfectly healthy branch
 * as **Offline** — the store refuses an unpaired caller, and the panel has
 * nothing to present. That failure has been repaired by hand twice, so it lives
 * here once and both callers use it: the client orchestrator's wiring step, and
 * a branch added on its own through `POST /api/stores`.
 *
 * A store with no company, or a company with no panel, is single-store: nothing
 * to pair, and `'no-panel'` says so rather than pretending.
 */
export const wireStoreToHeadOffice = async (store: StoreRecord): Promise<WiringOutcome> => {
  if (!store.company_id) return 'no-panel';
  const panel = listPanelsForCompany(store.company_id)[0];
  if (!panel) return 'no-panel';

  // Reuse the credential the branch already holds where there is one: rotating it
  // here would desync a branch that is already registered somewhere.
  const headOfficeToken = store.head_office_token ?? crypto.randomBytes(32).toString('hex');
  if (headOfficeToken !== store.head_office_token) {
    setStoreHeadOfficeToken(store.id, headOfficeToken);
  }

  await pushTerminals(store, {}, {
    headOffice: { enabled: true, url: panel.base_url, token: headOfficeToken },
  });

  await registerBranchWithPanel(panel, {
    slug: store.slug,
    name: store.name,
    baseUrl: store.base_url,
    headOfficeToken,
    vertical: store.vertical,
  });

  return 'wired';
};

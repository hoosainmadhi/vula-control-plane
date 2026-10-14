/**
 * The office's once-off onboarding pair, read once per session.
 *
 * Both figures have one home — Office Settings (2026-10-14) — and every surface
 * that shows or charges them reads them from there: the onboarding form, the
 * subscription editor, the Plans editor's hint. The module-level cache is
 * deliberate: the pair changes about once a year, and three pages each fetching
 * it would be three round trips for the same two numbers. A failed read falls
 * back to the published defaults so no screen renders an empty price.
 */
import { api } from '../api';
import { ASSISTED_SETUP_CENTS, SELF_SETUP_CENTS } from './money';

export interface OfficeSetupFees {
  self: number;
  assisted: number;
}

let cached: OfficeSetupFees | null = null;

export const officeSetupFees = async (): Promise<OfficeSetupFees> => {
  if (cached) return cached;
  try {
    const res = await api<{
      settings: { setupFeeSelfCents: number; setupFeeAssistedCents: number };
    }>('/settings');
    cached = {
      self: res.settings.setupFeeSelfCents ?? SELF_SETUP_CENTS,
      assisted: res.settings.setupFeeAssistedCents ?? ASSISTED_SETUP_CENTS,
    };
  } catch {
    cached = { self: SELF_SETUP_CENTS, assisted: ASSISTED_SETUP_CENTS };
  }
  return cached;
};

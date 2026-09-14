import {
  allocatedTerminalCount,
  getAllocationForStore,
  getPlanById,
  licensedTerminalCount,
  listAllocations,
  setAllocation,
  deleteAllocationForStore,
  type CompanyRecord,
  type PlanRecord,
  type StoreRecord,
} from '../config/registryDb.js';
import type { CapCheck } from './subscriptions.js';

/**
 * Terminal licences: the commercial quantity a client pays for, and where it
 * sits across the client's stores.
 *
 * Four quantities are deliberately kept apart — only the first is billable:
 *
 *  - **Licensed**  — purchased from the vendor; drives the subscription amount.
 *  - **Configured** — terminal slots the POS is told to run (`stores.terminal_count`).
 *  - **Claimed**   — actual device/browser bindings at the register.
 *  - **Open**      — trading sessions running right now.
 *
 * Claimed devices, open tills, heartbeats and configured counts never change what
 * a client pays. A store may not be configured for more tills than it is licensed
 * for, so the register's slots and its signed licence cannot drift apart.
 */

export interface AllocationCheck extends CapCheck {
  /** Machine-readable refusal code, for the API's 402 body. */
  code?: 'terminal_cap_exceeded' | 'terminal_allocation_exceeded';
}

const countError = (): AllocationCheck => ({
  ok: false,
  code: 'terminal_allocation_exceeded',
  reason: 'Terminal licences must be a whole number of 0 or more.',
});

/** A store's licence allowance and where it came from. */
export interface TerminalAllowance {
  count: number;
  /** `allocation` is the normal case; `configured` is the pre-subscription fallback. */
  source: 'allocation' | 'configured';
}

/**
 * The terminals a store's signed licence permits. An assigned store reads its
 * allocation. A store with no client, or one that predates allocations, falls
 * back to what it is already configured for — a licence change must never
 * retroactively block a store that is running today.
 */
export function terminalAllowance(store: Pick<StoreRecord, 'id' | 'company_id' | 'terminal_count'>): TerminalAllowance {
  if (store.company_id === null) {
    return { count: store.terminal_count, source: 'configured' };
  }
  const allocation = getAllocationForStore(store.id);
  if (!allocation) {
    return { count: store.terminal_count, source: 'configured' };
  }
  return { count: allocation.licensed_terminal_count, source: 'allocation' };
}

/** The plan ceiling for a company's stores, or null when it has no plan. */
export const planForCompany = (company: CompanyRecord | null): PlanRecord | null =>
  company?.plan_id ? getPlanById(company.plan_id) : null;

/**
 * Can this store hold `count` terminal licences?
 *
 *  - never more than the plan's per-store ceiling;
 *  - never more than the client's remaining purchased quantity, counting the
 *    store's own current allocation as replaceable.
 *
 * Reducing a store's allocation below what it is configured for is allowed and
 * reported, not refused: the licence gates NEW claims, and an operator lowering a
 * quantity must not be trapped by tills that already exist. Existing device
 * bindings are never revoked.
 */
export function checkAllocation(
  company: CompanyRecord,
  storeId: number,
  count: number,
): AllocationCheck {
  if (!Number.isInteger(count) || count < 0) return countError();

  const plan = planForCompany(company);
  const ceiling = plan?.max_terminals_per_store ?? count;
  if (count > ceiling) {
    return {
      ok: false,
      code: 'terminal_cap_exceeded',
      reason: `${company.name}'s ${plan?.name ?? 'assigned'} plan allows ${ceiling} terminals per store; ${count} requested. Upgrade the plan to add tills.`,
    };
  }

  const licensed = licensedTerminalCount(company.id);
  // Only the store's allocation *within this client* is replaceable; a store
  // moving in from another client must fit entirely within the free quantity.
  const existing = getAllocationForStore(storeId);
  const current = existing && existing.company_id === company.id ? existing.licensed_terminal_count : 0;
  const otherStores = allocatedTerminalCount(company.id) - current;
  if (otherStores + count > licensed) {
    const available = Math.max(licensed - otherStores, 0);
    return {
      ok: false,
      code: 'terminal_allocation_exceeded',
      reason: `${company.name} is licensed for ${licensed} terminal${licensed === 1 ? '' : 's'}; this would take the total to ${otherStores + count}. ${available > 0 ? `This store can hold up to ${available}.` : 'Increase the subscription or reduce another store.'}`,
    };
  }

  return { ok: true };
}

/**
 * Can a client take on a NEW store with `count` terminals? Same two rules as
 * `checkAllocation`, applied before the store exists — including the gate that a
 * client with no purchased terminals cannot add a store until the subscription
 * says how many it bought. (The client-first wizard always supplies the quantity;
 * this refusal is for the advanced companies/stores screens.)
 */
export function checkNewStoreAllocation(company: CompanyRecord, count: number): AllocationCheck {
  if (!Number.isInteger(count) || count < 1) {
    return {
      ok: false,
      code: 'terminal_cap_exceeded',
      reason: 'The terminal count must be a whole number of 1 or more.',
    };
  }

  const plan = planForCompany(company);
  const ceiling = plan?.max_terminals_per_store ?? count;
  if (count > ceiling) {
    return {
      ok: false,
      code: 'terminal_cap_exceeded',
      reason: `${company.name}'s ${plan?.name ?? 'assigned'} plan allows ${ceiling} terminals per store; ${count} requested. Upgrade the plan to add tills.`,
    };
  }

  const licensed = licensedTerminalCount(company.id);
  const allocated = allocatedTerminalCount(company.id);
  if (allocated + count > licensed) {
    const remaining = Math.max(licensed - allocated, 0);
    return {
      ok: false,
      code: 'terminal_allocation_exceeded',
      reason:
        licensed === 0
          ? `${company.name} has no licensed terminals yet. Set the client's licensed terminal quantity on its subscription before adding a store.`
          : `${company.name} is licensed for ${licensed} terminal${licensed === 1 ? '' : 's'}, with ${allocated} already allocated. This store needs ${count}${remaining > 0 ? ` (only ${remaining} free)` : ''}. Increase the subscription or reduce another store.`,
    };
  }

  return { ok: true };
}

/** Write a store's allocation, refusing a quantity the client has not bought. */
export function allocateTerminals(
  company: CompanyRecord,
  storeId: number,
  count: number,
): AllocationCheck {
  const check = checkAllocation(company, storeId, count);
  if (!check.ok) return check;
  setAllocation(company.id, storeId, count);
  return { ok: true };
}

/**
 * Can this store be CONFIGURED for `count` tills? Configured slots are what the
 * POS is told to run, so they are bounded by both the plan ceiling and the
 * store's own licence allowance — a store licensed for 2 tills has no business
 * running 5.
 */
export function checkConfiguredTerminals(
  company: CompanyRecord | null,
  store: Pick<StoreRecord, 'id' | 'company_id' | 'terminal_count'>,
  count: number,
): AllocationCheck {
  if (!Number.isInteger(count) || count < 1) {
    return { ok: false, code: 'terminal_cap_exceeded', reason: 'The terminal count must be a whole number of 1 or more.' };
  }
  if (!company) return { ok: true }; // unassigned stores are not policed

  const plan = planForCompany(company);
  const ceiling = plan?.max_terminals_per_store ?? count;
  if (count > ceiling) {
    return {
      ok: false,
      code: 'terminal_cap_exceeded',
      reason: `${company.name}'s ${plan?.name ?? 'assigned'} plan allows ${ceiling} terminals per store; ${count} requested. Upgrade the plan to add tills.`,
    };
  }

  const allowance = terminalAllowance(store);
  if (count > allowance.count) {
    return {
      ok: false,
      code: 'terminal_allocation_exceeded',
      reason:
        allowance.source === 'allocation'
          ? `${company.name} licenses ${allowance.count} terminal${allowance.count === 1 ? '' : 's'} for this store; ${count} configured. Raise the store's licensed terminals on the client's subscription first.`
          : `${company.name} has no licensed terminals yet; ${count} configured. Set the client's licensed terminal quantity on its subscription first.`,
    };
  }

  return { ok: true };
}

/** The allocation a store should start with when it joins a client. */
export function defaultAllocationFor(terminalCount: number): number {
  return Number.isInteger(terminalCount) && terminalCount > 0 ? terminalCount : 1;
}

/**
 * Release a store's licences when it leaves a client or is removed from the
 * registry. The client's purchased quantity is NOT reduced: the office decides
 * whether to reallocate or shrink the subscription.
 */
export const releaseStoreAllocation = (storeId: number): boolean => deleteAllocationForStore(storeId);

export interface SubscriptionSummary {
  licensedTerminalCount: number;
  allocatedTerminalCount: number;
  unallocatedTerminalCount: number;
  allocations: Array<{ storeId: number; licensedTerminalCount: number }>;
}

/** Licensed vs allocated for a client, with the per-store breakdown. */
export function summariseSubscription(companyId: number): SubscriptionSummary {
  const licensed = licensedTerminalCount(companyId);
  const allocations = listAllocations(companyId).map((a) => ({
    storeId: a.store_id,
    licensedTerminalCount: a.licensed_terminal_count,
  }));
  const allocated = allocations.reduce((n, a) => n + a.licensedTerminalCount, 0);
  return {
    licensedTerminalCount: licensed,
    allocatedTerminalCount: allocated,
    unallocatedTerminalCount: licensed - allocated,
    allocations,
  };
}

import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Invoice, Payment, Company } from '../types';

export default function BillingPage() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [runningRenewal, setRunningRenewal] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);

  // Modal states
  const [createOpen, setCreateOpen] = useState(false);
  const [payModalInvoice, setPayModalInvoice] = useState<Invoice | null>(null);
  const [viewingInvoice, setViewingInvoice] = useState<Invoice | null>(null);
  const [emailingInvoice, setEmailingInvoice] = useState<Invoice | null>(null);
  const [emailTarget, setEmailTarget] = useState<string>('');
  const [sendingEmail, setSendingEmail] = useState(false);

  // Form states
  const [newCompanyId, setNewCompanyId] = useState<string>('');
  const [newAmountRands, setNewAmountRands] = useState<string>('');
  const [newDueDate, setNewDueDate] = useState<string>('');
  const [payMethod, setPayMethod] = useState<'stripe' | 'manual' | 'bank_transfer' | 'credit_card' | 'paypal'>('manual');
  const [payTxId, setPayTxId] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const [invs, pays, comps] = await Promise.all([
        api<Invoice[]>('/billing/invoices'),
        api<Payment[]>('/billing/payments'),
        api<Company[]>('/companies'),
      ]);
      setInvoices(invs);
      setPayments(pays);
      setCompanies(comps);
    } catch (err) {
      setBanner({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to load billing data',
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleRunRenewal = async () => {
    setRunningRenewal(true);
    setBanner(null);
    try {
      const res = await api<{ ok: boolean; summary: { companiesEvaluated: number; renewalsProcessed: number; invoicesCreated: number; errors: string[] } }>(
        '/billing/renew-check',
        { method: 'POST' },
      );
      setBanner({
        kind: 'ok',
        message: `Auto-renewal cycle complete: ${res.summary.renewalsProcessed} renewals processed, ${res.summary.invoicesCreated} invoices created across ${res.summary.companiesEvaluated} companies.`,
      });
      loadData();
    } catch (err) {
      setBanner({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to run renewal cycle',
      });
    } finally {
      setRunningRenewal(false);
    }
  };

  const handleCreateInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCompanyId) return;
    setSubmitting(true);
    setBanner(null);
    try {
      const amountCents = newAmountRands ? Math.round(parseFloat(newAmountRands) * 100) : undefined;
      await api('/billing/invoices', {
        method: 'POST',
        body: {
          companyId: Number(newCompanyId),
          amountCents,
          dueDate: newDueDate || undefined,
        },
      });
      setBanner({ kind: 'ok', message: 'Invoice generated successfully' });
      setCreateOpen(false);
      setNewCompanyId('');
      setNewAmountRands('');
      setNewDueDate('');
      loadData();
    } catch (err) {
      setBanner({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to create invoice',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handlePayInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payModalInvoice) return;
    setSubmitting(true);
    setBanner(null);
    try {
      const res = await api<{ ok: boolean; newPaidThrough: string; licencePush: { storesUpdated: number; panelsUpdated: number } }>(
        `/billing/invoices/${payModalInvoice.id}/pay`,
        {
          method: 'POST',
          body: {
            method: payMethod,
            transactionId: payTxId || undefined,
          },
        },
      );
      setBanner({
        kind: 'ok',
        message: `Payment confirmed! Subscription advanced to ${res.newPaidThrough}. Licences pushed to ${res.licencePush.storesUpdated} stores & ${res.licencePush.panelsUpdated} Head Office panels.`,
      });
      setPayModalInvoice(null);
      setPayTxId('');
      loadData();
    } catch (err) {
      setBanner({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to process payment',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelInvoice = async (invoice: Invoice) => {
    if (!confirm(`Cancel invoice ${invoice.invoiceNumber}?`)) return;
    setBanner(null);
    try {
      await api(`/billing/invoices/${invoice.id}/cancel`, { method: 'POST' });
      setBanner({ kind: 'ok', message: `Invoice ${invoice.invoiceNumber} cancelled.` });
      loadData();
    } catch (err) {
      setBanner({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to cancel invoice',
      });
    }
  };

  const handleSendInvoiceEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailingInvoice) return;
    setSendingEmail(true);
    setBanner(null);
    try {
      const res = await api<{ ok: boolean; recipient: string; invoiceNumber: string }>(
        `/billing/invoices/${emailingInvoice.id}/email`,
        {
          method: 'POST',
          body: { email: emailTarget || undefined },
        },
      );
      setBanner({
        kind: 'ok',
        message: `Invoice ${res.invoiceNumber} emailed successfully to ${res.recipient}.`,
      });
      setEmailingInvoice(null);
      setEmailTarget('');
    } catch (err) {
      setBanner({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to email invoice',
      });
    } finally {
      setSendingEmail(false);
    }
  };

  const filteredInvoices = invoices.filter((inv) => {
    if (statusFilter === 'all') return true;
    return inv.status === statusFilter;
  });

  const totalInvoicedCents = invoices.reduce((acc, inv) => acc + (inv.status !== 'cancelled' ? inv.amountCents : 0), 0);
  const totalPaidCents = invoices.reduce((acc, inv) => acc + (inv.status === 'paid' ? inv.amountCents : 0), 0);
  const totalPendingCents = invoices.reduce((acc, inv) => acc + (inv.status === 'pending' || inv.status === 'overdue' ? inv.amountCents : 0), 0);

  const selectedCompany = companies.find((c) => String(c.id) === newCompanyId);

  const formatRand = (cents: number): string =>
    new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(cents / 100);

  return (
    <div className="space-y-6">
      {/* Banner */}
      {banner && (
        <div
          className={`flex items-center justify-between rounded-xl p-4 text-sm font-semibold shadow-xs ${
            banner.kind === 'ok'
              ? 'border border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border border-red-200 bg-red-50 text-red-800'
          }`}
        >
          <span>{banner.message}</span>
          <button
            onClick={() => setBanner(null)}
            className="text-xs font-bold uppercase tracking-wider opacity-70 hover:opacity-100"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-400">Total Billed</div>
          <div className="mt-2 text-2xl font-black text-slate-900">{formatRand(totalInvoicedCents)}</div>
          <div className="mt-1 text-xs text-slate-500">{invoices.length} total invoices raised</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <div className="text-xs font-bold uppercase tracking-wider text-emerald-600">Collected Revenue</div>
          <div className="mt-2 text-2xl font-black text-emerald-600">{formatRand(totalPaidCents)}</div>
          <div className="mt-1 text-xs text-slate-500">{invoices.filter((i) => i.status === 'paid').length} settled invoices</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <div className="text-xs font-bold uppercase tracking-wider text-amber-600">Outstanding Receivables</div>
          <div className="mt-2 text-2xl font-black text-amber-600">{formatRand(totalPendingCents)}</div>
          <div className="mt-1 text-xs text-slate-500">{invoices.filter((i) => i.status === 'pending' || i.status === 'overdue').length} awaiting settlement</div>
        </div>
      </div>

      {/* Actions and Filters Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-2xs">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-wide text-slate-400">Status:</span>
          {['all', 'pending', 'paid', 'overdue', 'cancelled'].map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold capitalize transition-colors ${
                statusFilter === status
                  ? 'bg-slate-900 text-white shadow-2xs'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {status}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleRunRenewal}
            disabled={runningRenewal}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-2xs hover:bg-slate-50 disabled:opacity-50"
            title="Scan all companies, generate renewal invoices, and push licences"
          >
            {runningRenewal ? 'Checking renewals…' : 'Run Auto-Renewal Check'}
          </button>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="rounded-lg bg-brand-600 px-3.5 py-2 text-xs font-bold text-white shadow-xs hover:bg-brand-700"
          >
            + Create Invoice
          </button>
        </div>
      </div>

      {/* Invoices Table */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xs">
        <div className="border-b border-slate-200 px-5 py-4">
          <h3 className="text-base font-bold text-slate-900">Subscription Invoices</h3>
          <p className="text-xs text-slate-500">Automated invoices, payments, and subscription entitlement renewals</p>
        </div>
        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">Loading invoices…</div>
        ) : filteredInvoices.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">No invoices match the selected filter.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-[11px] font-bold uppercase tracking-wider text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="px-5 py-3">Invoice #</th>
                  <th className="px-5 py-3">Company</th>
                  <th className="px-5 py-3">Due Date</th>
                  <th className="px-5 py-3">Amount</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {filteredInvoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-slate-50/60">
                    <td className="px-5 py-3.5 font-mono text-xs font-bold text-slate-900">{inv.invoiceNumber}</td>
                    <td className="px-5 py-3.5 font-semibold text-slate-800">{inv.companyName}</td>
                    <td className="px-5 py-3.5 text-xs text-slate-600">{inv.dueDate || '—'}</td>
                    <td className="px-5 py-3.5 font-bold text-slate-900">{formatRand(inv.amountCents)}</td>
                    <td className="px-5 py-3.5">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-bold capitalize ${
                          inv.status === 'paid'
                            ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-500/20'
                            : inv.status === 'pending'
                            ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-500/20'
                            : inv.status === 'overdue'
                            ? 'bg-red-50 text-red-700 ring-1 ring-red-500/20'
                            : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {inv.status}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-right space-x-1.5">
                      <button
                        type="button"
                        onClick={() => setViewingInvoice(inv)}
                        className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-bold text-slate-700 shadow-2xs hover:bg-slate-50 cursor-pointer"
                        title="View and print invoice"
                      >
                        View
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEmailingInvoice(inv);
                          const comp = companies.find((c) => c.id === inv.companyId);
                          setEmailTarget(comp?.billingEmail || '');
                        }}
                        className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-bold text-slate-700 shadow-2xs hover:bg-slate-50 cursor-pointer"
                        title="Email invoice to client"
                      >
                        Email
                      </button>
                      {inv.status === 'pending' || inv.status === 'overdue' ? (
                        <>
                          <button
                            type="button"
                            onClick={() => setPayModalInvoice(inv)}
                            className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-bold text-white shadow-2xs hover:bg-emerald-700 cursor-pointer"
                          >
                            Pay
                          </button>
                          <button
                            type="button"
                            onClick={() => handleCancelInvoice(inv)}
                            className="rounded-md bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-200 cursor-pointer"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <span className="text-xs text-slate-400">
                          {inv.status === 'paid' ? `Settled on ${inv.paidDate}` : 'Cancelled'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent Payments Stream */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xs">
        <div className="border-b border-slate-200 px-5 py-4">
          <h3 className="text-base font-bold text-slate-900">Recent Payment Ledger</h3>
          <p className="text-xs text-slate-500">Audit trail of settled subscription fees</p>
        </div>
        {payments.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500">No payment records yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-[11px] font-bold uppercase tracking-wider text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="px-5 py-3">Date</th>
                  <th className="px-5 py-3">Amount</th>
                  <th className="px-5 py-3">Method</th>
                  <th className="px-5 py-3">Transaction / Ref</th>
                  <th className="px-5 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {payments.slice(0, 10).map((p) => (
                  <tr key={p.id}>
                    <td className="px-5 py-3 text-xs text-slate-600">{p.createdAt}</td>
                    <td className="px-5 py-3 font-bold text-emerald-600">{formatRand(p.amountCents)}</td>
                    <td className="px-5 py-3 font-semibold uppercase text-xs text-slate-700">{p.method.replace('_', ' ')}</td>
                    <td className="px-5 py-3 font-mono text-xs text-slate-600">{p.transactionId || '—'}</td>
                    <td className="px-5 py-3">
                      <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700 ring-1 ring-emerald-500/20">
                        {p.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create Invoice Modal */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-2xs">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-bold text-slate-900">Create Subscription Invoice</h3>
            <p className="mt-1 text-xs text-slate-500">Raise an invoice for a merchant company</p>
            <form onSubmit={handleCreateInvoice} className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700">Company</label>
                <select
                  required
                  value={newCompanyId}
                  onChange={(e) => setNewCompanyId(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm"
                >
                  <option value="">Select merchant company…</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.planName})
                    </option>
                  ))}
                </select>
              </div>

              {selectedCompany && (
                <div className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
                  {selectedCompany.subscription.recurringAmountCents === null ? (
                    <span className="font-semibold text-amber-700">
                      {selectedCompany.name} is on custom pricing — enter the agreed amount.
                    </span>
                  ) : (
                    <>
                      Plan default:{' '}
                      <span className="font-mono font-bold text-slate-800">
                        {formatRand(selectedCompany.subscription.recurringAmountCents)}
                      </span>{' '}
                      ({selectedCompany.subscription.licensedTerminalCount} licensed terminals ×{' '}
                      {formatRand(selectedCompany.subscription.rateCents)})
                      {selectedCompany.subscription.setupFeeStatus === 'not_invoiced' &&
                        selectedCompany.subscription.setupFeeCents > 0 && (
                          <>
                            {' '}
                            + {formatRand(selectedCompany.subscription.setupFeeCents)} once-off onboarding
                          </>
                        )}
                    </>
                  )}
                </div>
              )}

              <div>
                <label className="block text-xs font-bold text-slate-700">Amount (ZAR)</label>
                <input
                  type="number"
                  step="0.01"
                  placeholder={
                    selectedCompany?.subscription.recurringAmountCents === null
                      ? 'Required for custom-priced clients'
                      : 'Leave empty to use the subscription amount'
                  }
                  value={newAmountRands}
                  onChange={(e) => setNewAmountRands(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700">Due Date</label>
                <input
                  type="date"
                  value={newDueDate}
                  onChange={(e) => setNewDueDate(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setCreateOpen(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-lg bg-brand-600 px-4 py-2 text-xs font-bold text-white shadow-xs hover:bg-brand-700 disabled:opacity-50"
                >
                  {submitting ? 'Creating…' : 'Generate Invoice'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Record Payment Modal */}
      {payModalInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-2xs">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-bold text-slate-900">Record Payment & Renew Licence</h3>
            <p className="mt-1 text-xs text-slate-500">
              Settling {payModalInvoice.invoiceNumber} ({formatRand(payModalInvoice.amountCents)}) for{' '}
              <span className="font-semibold">{payModalInvoice.companyName}</span> will advance their subscription and push an updated licence.
            </p>
            <form onSubmit={handlePayInvoice} className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700">Payment Method</label>
                <select
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value as any)}
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm"
                >
                  <option value="manual">Manual EFT / Bank Deposit</option>
                  <option value="bank_transfer">Direct Debit / Bank Transfer</option>
                  <option value="stripe">Stripe Gateway</option>
                  <option value="credit_card">Card Terminal / POS</option>
                  <option value="paypal">PayPal</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700">Transaction ID / Bank Reference</label>
                <input
                  type="text"
                  placeholder="e.g. EFT-2026-9481 or ch_3P7..."
                  value={payTxId}
                  onChange={(e) => setPayTxId(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm font-mono text-xs"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setPayModalInvoice(null)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-bold text-white shadow-xs hover:bg-emerald-700 disabled:opacity-50"
                >
                  {submitting ? 'Settling…' : 'Confirm Payment & Push Licence'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* View Invoice Modal */}
      {viewingInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-2xs">
          <div className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-2xl border border-slate-200">
            {/* Printable Invoice Container */}
            <div className="border-b border-slate-200 pb-4 flex justify-between items-start">
              <div>
                <div className="flex items-center gap-2">
                  <div className="size-8 rounded-lg bg-emerald-600 flex items-center justify-center text-white font-black text-sm">V</div>
                  <span className="font-black text-base text-slate-900 tracking-tight">Vula Platform</span>
                </div>
                <div className="text-[11px] text-slate-500 mt-1">SaaS POS Software Subscription</div>
              </div>
              <div className="text-right">
                <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-bold uppercase ${
                  viewingInvoice.status === 'paid'
                    ? 'bg-emerald-50 text-emerald-700'
                    : viewingInvoice.status === 'pending'
                    ? 'bg-amber-50 text-amber-700'
                    : 'bg-slate-100 text-slate-600'
                }`}>
                  {viewingInvoice.status}
                </span>
                <div className="font-mono text-sm font-black text-slate-900 mt-1">{viewingInvoice.invoiceNumber}</div>
                <div className="text-[11px] text-slate-400">Date: {viewingInvoice.createdAt.slice(0, 10)}</div>
              </div>
            </div>

            <div className="py-4 border-b border-slate-100 grid grid-cols-2 gap-4 text-xs">
              <div>
                <span className="font-bold text-slate-400 uppercase text-[10px]">Billed To</span>
                <div className="font-bold text-slate-900 text-sm mt-0.5">{viewingInvoice.companyName}</div>
                <div className="text-slate-500">
                  {companies.find((c) => c.id === viewingInvoice.companyId)?.billingEmail || 'No billing email'}
                </div>
              </div>
              <div className="text-right">
                <span className="font-bold text-slate-400 uppercase text-[10px]">Payment Due</span>
                <div className="font-semibold text-slate-800 mt-0.5">{viewingInvoice.dueDate || 'Upon receipt'}</div>
                {viewingInvoice.paidDate && (
                  <div className="text-emerald-600 font-semibold text-[11px]">Settled: {viewingInvoice.paidDate}</div>
                )}
              </div>
            </div>

            {/* Line Items */}
            <div className="py-4">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-400 uppercase text-[10px]">
                    <th className="py-2 text-left">Description</th>
                    <th className="py-2 text-right">Amount (ZAR)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {viewingInvoice.terminalCount !== null &&
                  viewingInvoice.terminalPriceCents !== null ? (
                    <>
                      {/* Recurring line: licensed terminals × the rate at the time
                          of issue. Never derived from claimed devices or open tills. */}
                      <tr>
                        <td className="py-3">
                          <div className="font-bold text-slate-800">
                            {viewingInvoice.terminalCount} licensed terminal
                            {viewingInvoice.terminalCount === 1 ? '' : 's'}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            @ {formatRand(viewingInvoice.terminalPriceCents)} per terminal ·{' '}
                            {companies.find((c) => c.id === viewingInvoice.companyId)?.planName ??
                              'Subscription'}
                          </div>
                        </td>
                        <td className="py-3 text-right font-mono font-bold text-slate-900">
                          {formatRand(viewingInvoice.terminalCount * viewingInvoice.terminalPriceCents)}
                        </td>
                      </tr>
                      {(viewingInvoice.setupFeeCents ?? 0) > 0 && (
                        <tr>
                          <td className="py-3">
                            <div className="font-bold text-slate-800">
                              Vula onboarding and deployment
                            </div>
                            <div className="text-[11px] text-slate-500">
                              Once-off — not repeated on renewals
                            </div>
                          </td>
                          <td className="py-3 text-right font-mono font-bold text-slate-900">
                            {formatRand(viewingInvoice.setupFeeCents ?? 0)}
                          </td>
                        </tr>
                      )}
                    </>
                  ) : (
                    <tr>
                      <td className="py-3">
                        <div className="font-bold text-slate-800">Vula POS Subscription</div>
                        <div className="text-[11px] text-slate-500">
                          {viewingInvoice.setupFeeCents && viewingInvoice.setupFeeCents > 0
                            ? `Agreed amount · Tier: ${
                                companies.find((c) => c.id === viewingInvoice.companyId)?.planName ??
                                'Custom'
                              }`
                            : `Tier: ${
                                companies.find((c) => c.id === viewingInvoice.companyId)?.planName ??
                                'Custom'
                              }`}
                        </div>
                      </td>
                      <td className="py-3 text-right font-mono font-bold text-slate-900">
                        {formatRand(viewingInvoice.amountCents)}
                      </td>
                    </tr>
                  )}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-200 font-bold">
                    <td className="pt-3 text-slate-900">Total Consideration Due</td>
                    <td className="pt-3 text-right font-mono text-base text-slate-900">
                      {formatRand(viewingInvoice.amountCents)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Actions */}
            <div className="mt-4 pt-3 border-t border-slate-100 flex justify-between items-center">
              <button
                type="button"
                onClick={() => window.print()}
                className="rounded-lg border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                🖨 Print / PDF
              </button>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const inv = viewingInvoice;
                    setViewingInvoice(null);
                    setEmailingInvoice(inv);
                    const comp = companies.find((c) => c.id === inv.companyId);
                    setEmailTarget(comp?.billingEmail || '');
                  }}
                  className="rounded-lg border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  ✉ Email to Client
                </button>
                <button
                  type="button"
                  onClick={() => setViewingInvoice(null)}
                  className="rounded-lg bg-slate-900 px-4 py-1.5 text-xs font-bold text-white hover:bg-slate-800 cursor-pointer"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Email Invoice Modal */}
      {emailingInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-2xs">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl border border-slate-200">
            <h3 className="text-lg font-bold text-slate-900">Email Subscription Invoice</h3>
            <p className="mt-1 text-xs text-slate-500">
              Send {emailingInvoice.invoiceNumber} to <span className="font-semibold">{emailingInvoice.companyName}</span>
            </p>
            <form onSubmit={handleSendInvoiceEmail} className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700">Recipient Email Address *</label>
                <input
                  type="email"
                  required
                  placeholder="accounts@client.co.za"
                  value={emailTarget}
                  onChange={(e) => setEmailTarget(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEmailingInvoice(null)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={sendingEmail || !emailTarget}
                  className="rounded-lg bg-brand-600 px-4 py-2 text-xs font-bold text-white shadow-xs hover:bg-brand-700 disabled:opacity-50 cursor-pointer"
                >
                  {sendingEmail ? 'Sending…' : 'Send Invoice Email'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

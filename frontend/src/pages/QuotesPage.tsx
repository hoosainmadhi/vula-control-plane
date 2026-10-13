import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, getToken } from '../api';
import ErrorBox from '../components/ErrorBox';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import StatusBadge from '../components/StatusBadge';
import { SummaryTile } from '../components/storeUi';
import { rand } from '../lib/money';
import { fmtAgo, fmtTime } from '../lib/storeVocab';
import type { Quote } from '../types';

/** The pipeline's states, tinted like the rest of the SPOG. */
const STATUS_COLORS: Record<string, string> = {
  new: 'bg-sky-100 text-sky-700',
  quoted: 'bg-indigo-100 text-indigo-700',
  accepted: 'bg-green-100 text-green-700',
  declined: 'bg-rose-100 text-rose-700',
};

const STATUS_FILTERS: Array<{ id: Quote['status'] | 'all' | 'expired'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'new', label: 'New' },
  { id: 'quoted', label: 'Quoted' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'declined', label: 'Declined' },
  { id: 'expired', label: 'Expired' },
];

const inputCls =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none';
const labelCls = 'mb-1 block text-xs font-bold text-slate-700';
const primaryBtn =
  'rounded-lg bg-brand-600 px-4 py-2 text-xs font-bold text-white shadow-xs hover:bg-brand-700 disabled:opacity-50';
const secondaryBtn =
  'rounded-lg border border-slate-200 px-3.5 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50';
const dangerBtn =
  'rounded-lg border border-red-200 px-3.5 py-2 text-xs font-bold text-red-600 hover:bg-red-50 disabled:opacity-50';

const setupLabel = (variant: string): string =>
  variant === 'assisted' ? 'Assisted set-up' : 'Self set-up';

/** A slug from a name — the same derivation the plans page uses. */
const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

interface VocabularyFeature {
  key: string;
  label: string;
  soldMonthly: boolean;
}

interface PlanOption {
  id: number;
  name: string;
  isActive?: boolean;
}

export default function QuotesPage() {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  /** The vocabulary: names, and which features are sold monthly (owner 2026-10-10). */
  const [vocabulary, setVocabulary] = useState<VocabularyFeature[]>([]);
  /** Client names for the back-link a converted quote shows. */
  const [clientNames, setClientNames] = useState<Record<number, string>>({});
  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [statusFilter, setStatusFilter] = useState<Quote['status'] | 'all' | 'expired'>('all');
  const [detail, setDetail] = useState<Quote | null>(null);
  const [notice, setNotice] = useState('');

  // The send panel: prefilled from the record, re-priced by the server.
  const [sendOpen, setSendOpen] = useState(false);
  const [sendStores, setSendStores] = useState('1');
  const [sendTills, setSendTills] = useState('1');
  const [sendSetup, setSendSetup] = useState('assisted');
  const [sendAddons, setSendAddons] = useState<Set<string>>(new Set());
  const [sendBusy, setSendBusy] = useState(false);
  const [sendError, setSendError] = useState('');
  const [pdfError, setPdfError] = useState('');
  const [outcomeBusy, setOutcomeBusy] = useState(false);

  // The create panel: the office's own draft for a phone-in prospect.
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusiness, setCreateBusiness] = useState('');
  const [createContactName, setCreateContactName] = useState('');
  const [createEmail, setCreateEmail] = useState('');
  const [createPhone, setCreatePhone] = useState('');
  const [createVertical, setCreateVertical] = useState('');
  const [createNote, setCreateNote] = useState('');
  const [createStores, setCreateStores] = useState('1');
  const [createTills, setCreateTills] = useState('1');
  const [createSetup, setCreateSetup] = useState('assisted');
  const [createAddons, setCreateAddons] = useState<Set<string>>(new Set());
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState('');
  const [pageNotice, setPageNotice] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  // The edit panel: corrections to the prospect's details and the configuration.
  const [editOpen, setEditOpen] = useState(false);
  const [editBusiness, setEditBusiness] = useState('');
  const [editContactName, setEditContactName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editVertical, setEditVertical] = useState('');
  const [editNote, setEditNote] = useState('');
  const [editStores, setEditStores] = useState('1');
  const [editTills, setEditTills] = useState('1');
  const [editSetup, setEditSetup] = useState('assisted');
  const [editAddons, setEditAddons] = useState<Set<string>>(new Set());
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState('');

  // The create-client panel: prefilled from the record, confirmed by the office.
  const [clientOpen, setClientOpen] = useState(false);
  const [clientName, setClientName] = useState('');
  const [clientSlug, setClientSlug] = useState('');
  const [clientPlanId, setClientPlanId] = useState('');
  const [clientTills, setClientTills] = useState('1');
  const [clientBusy, setClientBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const [list, features, clients, planList] = await Promise.all([
        api<{ quotes: Quote[] }>('/quotes'),
        api<VocabularyFeature[]>('/plans/features').catch(() => []),
        api<Array<{ id: number; name: string }>>('/clients').catch(() => []),
        api<PlanOption[]>('/plans').catch(() => []),
      ]);
      setQuotes(list.quotes);
      setVocabulary(features);
      setClientNames(Object.fromEntries(clients.map((c) => [c.id, c.name])));
      setPlans(planList.filter((p) => p.isActive !== false));
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not load the quotes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const featureLabels = useMemo(
    () => Object.fromEntries(vocabulary.map((f) => [f.key, f.label])),
    [vocabulary],
  );
  const soldAddons = useMemo(() => vocabulary.filter((f) => f.soldMonthly), [vocabulary]);

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return quotes;
    if (statusFilter === 'expired') return quotes.filter((q) => q.expired);
    return quotes.filter((q) => q.status === statusFilter);
  }, [quotes, statusFilter]);

  const totals = useMemo(
    () => ({
      fresh: quotes.filter((q) => q.status === 'new').length,
      quoted: quotes.filter((q) => q.status === 'quoted').length,
      accepted: quotes.filter((q) => q.status === 'accepted').length,
      // The list arrives newest first, so the head is the latest request.
      newest: quotes[0]?.createdAt ?? null,
    }),
    [quotes],
  );

  const addonNames = (quote: Quote): string =>
    quote.addons.map((key) => featureLabels[key] ?? key).join(' · ');

  const updateQuote = (updated: Quote): void => {
    setQuotes((list) => list.map((q) => (q.id === updated.id ? updated : q)));
    setDetail(updated);
  };

  const openSend = (quote: Quote): void => {
    setSendStores(String(quote.stores));
    // The forms work in tills per store — the product's own model (the marketing
    // builder asks the same two numbers). A record whose total is not a clean
    // multiple starts at one per store.
    setSendTills(String(quote.tills % quote.stores === 0 ? quote.tills / quote.stores : 1));
    setSendSetup(quote.setupVariant);
    setSendAddons(new Set(quote.addons));
    setSendError('');
    setNotice('');
    setPdfError('');
    setClientOpen(false);
    setEditOpen(false);
    setSendOpen(true);
  };

  const toggleSendAddon = (key: string): void => {
    setSendAddons((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const downloadPdf = async (quote: Quote): Promise<void> => {
    setPdfError('');
    try {
      // The PDF route is office-gated, so a plain link would arrive without the
      // session token; fetch it with the header and hand the browser a blob.
      const res = await fetch(`/api/quotes/${quote.id}/pdf`, {
        headers: { Authorization: `Bearer ${getToken() ?? ''}` },
      });
      if (!res.ok) throw new Error(`Could not build the PDF (HTTP ${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `${quote.number}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : 'Could not download the quotation');
    }
  };

  const sendQuote = async (): Promise<void> => {
    if (!detail) return;
    setSendBusy(true);
    setSendError('');
    try {
      const res = await api<{ quote: Quote }>(`/quotes/${detail.id}/send`, {
        method: 'POST',
        body: {
          stores: Number(sendStores),
          tills: Number(sendStores) * Number(sendTills),
          addons: Array.from(sendAddons),
          setup: sendSetup,
        },
      });
      updateQuote(res.quote);
      setSendOpen(false);
      setNotice(
        `Quotation ${res.quote.number} sent to ${res.quote.email}` +
          (res.quote.validUntil ? ` — valid until ${res.quote.validUntil}.` : '.'),
      );
    } catch (err) {
      setSendError(err instanceof ApiError ? err.message : 'Could not send the quotation');
    } finally {
      setSendBusy(false);
    }
  };

  const recordOutcome = async (kind: 'accept' | 'decline'): Promise<void> => {
    if (!detail) return;
    setOutcomeBusy(true);
    setSendError('');
    setNotice('');
    try {
      const res = await api<{ quote: Quote }>(`/quotes/${detail.id}/${kind}`, { method: 'POST' });
      updateQuote(res.quote);
      setSendOpen(false);
      if (kind === 'accept') {
        setNotice(`Recorded — ${res.quote.number} is accepted.`);
        // The natural next step is the client; open its panel for them.
        openClient(res.quote);
      } else {
        setClientOpen(false);
        setNotice(`Recorded — ${res.quote.number} is declined.`);
      }
    } catch (err) {
      setSendError(err instanceof ApiError ? err.message : 'Could not record the outcome');
    } finally {
      setOutcomeBusy(false);
    }
  };

  const openClient = (quote: Quote): void => {
    setClientName(quote.business);
    setClientSlug(slugify(quote.business));
    setClientPlanId(plans[0] ? String(plans[0].id) : '');
    setClientTills(String(quote.tills));
    setSendError('');
    setNotice('');
    setSendOpen(false);
    setClientOpen(true);
  };

  const createClient = async (): Promise<void> => {
    if (!detail) return;
    setClientBusy(true);
    setSendError('');
    try {
      const res = await api<{ quote: Quote; company: { id: number; name: string; slug: string } }>(
        `/quotes/${detail.id}/create-client`,
        {
          method: 'POST',
          body: {
            name: clientName,
            slug: clientSlug,
            planId: clientPlanId === '' ? null : Number(clientPlanId),
            licensedTerminalCount: Number(clientTills),
          },
        },
      );
      updateQuote(res.quote);
      setClientNames((names) => ({ ...names, [res.company.id]: res.company.name }));
      setClientOpen(false);
      setNotice(`Client "${res.company.name}" created from ${res.quote.number}.`);
    } catch (err) {
      setSendError(err instanceof ApiError ? err.message : 'Could not create the client');
    } finally {
      setClientBusy(false);
    }
  };

  const openCreate = (): void => {
    setCreateBusiness('');
    setCreateContactName('');
    setCreateEmail('');
    setCreatePhone('');
    setCreateVertical('');
    setCreateNote('');
    setCreateStores('1');
    setCreateTills('1');
    setCreateSetup('assisted');
    setCreateAddons(new Set());
    setCreateError('');
    setNotice('');
    setCreateOpen(true);
  };

  const toggleCreateAddon = (key: string): void => {
    setCreateAddons((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const createQuote = async (): Promise<void> => {
    setCreateBusy(true);
    setCreateError('');
    try {
      const res = await api<{ quote: Quote }>('/quotes', {
        method: 'POST',
        body: {
          business: createBusiness,
          contactName: createContactName,
          email: createEmail,
          phone: createPhone,
          vertical: createVertical,
          note: createNote,
          stores: Number(createStores),
          tills: Number(createStores) * Number(createTills),
          addons: Array.from(createAddons),
          setup: createSetup,
        },
      });
      setQuotes((list) => [res.quote, ...list]);
      setCreateOpen(false);
      setDetail(res.quote);
      setNotice(
        `${res.quote.number} drafted for ${res.quote.business} — send it when you’re ready.`,
      );
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Could not create the quote');
    } finally {
      setCreateBusy(false);
    }
  };

  const openEdit = (quote: Quote): void => {
    setEditBusiness(quote.business);
    setEditContactName(quote.contactName);
    setEditEmail(quote.email);
    setEditPhone(quote.phone);
    setEditVertical(quote.vertical);
    setEditNote(quote.note);
    setEditStores(String(quote.stores));
    setEditTills(String(quote.tills % quote.stores === 0 ? quote.tills / quote.stores : 1));
    setEditSetup(quote.setupVariant);
    setEditAddons(new Set(quote.addons));
    setEditError('');
    setNotice('');
    setPdfError('');
    setSendOpen(false);
    setClientOpen(false);
    setEditOpen(true);
  };

  const toggleEditAddon = (key: string): void => {
    setEditAddons((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const saveEdit = async (): Promise<void> => {
    if (!detail) return;
    setEditBusy(true);
    setEditError('');
    try {
      const res = await api<{ quote: Quote }>(`/quotes/${detail.id}`, {
        method: 'PUT',
        body: {
          business: editBusiness,
          contactName: editContactName,
          email: editEmail,
          phone: editPhone,
          vertical: editVertical,
          note: editNote,
          stores: Number(editStores),
          tills: Number(editStores) * Number(editTills),
          addons: Array.from(editAddons),
          setup: editSetup,
        },
      });
      updateQuote(res.quote);
      setEditOpen(false);
      setNotice(`${res.quote.number} updated.`);
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : 'Could not save the changes');
    } finally {
      setEditBusy(false);
    }
  };

  const deleteQuote = async (): Promise<void> => {
    if (!detail) return;
    setDeleteBusy(true);
    setDeleteError('');
    try {
      await api<{ ok: boolean }>(`/quotes/${detail.id}`, { method: 'DELETE' });
      setQuotes((list) => list.filter((q) => q.id !== detail.id));
      setDeleteOpen(false);
      setDetail(null);
      setPageNotice(`${detail.number} deleted. The number is retired, not reused.`);
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : 'Could not delete the quote');
    } finally {
      setDeleteBusy(false);
    }
  };

  if (loading) return <Spinner label="Loading quotes…" />;
  if (loadError) {
    return (
      <div className="space-y-4">
        <ErrorBox message={loadError} />
        <button
          onClick={() => void load()}
          className="text-sm font-semibold text-brand-600 hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryTile
          label="New requests"
          value={totals.fresh}
          tone={totals.fresh ? 'brand' : 'slate'}
        />
        <SummaryTile label="Quoted" value={totals.quoted} />
        <SummaryTile
          label="Accepted"
          value={totals.accepted}
          tone={totals.accepted ? 'green' : 'slate'}
        />
        <SummaryTile label="Newest" value={totals.newest ? fmtAgo(totals.newest) : '—'} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setStatusFilter(f.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-bold transition ${
                statusFilter === f.id
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button onClick={openCreate} className={`ml-auto ${primaryBtn}`}>
          Create quote
        </button>
        <button
          onClick={() => void load()}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>

      {pageNotice ? (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm font-semibold text-green-800">
          {pageNotice}
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          {quotes.length === 0
            ? 'No quote requests yet — the marketing site’s builder posts them here.'
            : 'No quotes in this state.'}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-2.5 text-left">Quote</th>
                <th className="px-4 py-2.5 text-left">Contact</th>
                <th className="px-4 py-2.5 text-left">Configuration</th>
                <th className="px-4 py-2.5 text-right">Monthly</th>
                <th className="px-4 py-2.5 text-right">Set-up</th>
                <th className="px-4 py-2.5 text-left">Status</th>
                <th className="px-4 py-2.5 text-right">Received</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((q) => (
                <tr
                  key={q.id}
                  onClick={() => {
                    setDetail(q);
                    setNotice('');
                    setSendError('');
                    setPdfError('');
                    setPageNotice('');
                    setSendOpen(false);
                    setClientOpen(false);
                    setEditOpen(false);
                  }}
                  className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
                >
                  <td className="px-4 py-2.5">
                    <div className="font-semibold text-slate-700">{q.business || 'a visitor'}</div>
                    <div className="mt-0.5 flex items-center gap-1.5">
                      <span className="font-mono text-[10px] text-slate-400">{q.number}</span>
                      {q.source === 'office' ? (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-500">
                          Office
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">
                    <div>{q.contactName || '—'}</div>
                    <div className="text-slate-400">{q.email}</div>
                    <div className="text-slate-400">{q.phone}</div>
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">
                    <div>
                      {q.stores} {q.stores === 1 ? 'store' : 'stores'} · {q.tills}{' '}
                      {q.tills === 1 ? 'till' : 'tills'}
                      {q.stores > 1 && q.tills % q.stores === 0
                        ? ` (${q.tills / q.stores}/store)`
                        : ''}{' '}
                      · {setupLabel(q.setupVariant)}
                    </div>
                    <div className="text-slate-400">{addonNames(q) || 'no add-ons'}</div>
                  </td>
                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-slate-700">
                    {rand(q.priced.monthlyTotalCents)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">
                    {rand(q.priced.setupCents)}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-1">
                      <StatusBadge status={q.status} colors={STATUS_COLORS} />
                      {q.expired ? (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-800">
                          Expired
                        </span>
                      ) : null}
                      {q.drift ? (
                        <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-700">
                          Price drift
                        </span>
                      ) : null}
                      {q.emailError ? (
                        <span className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-bold uppercase text-red-700">
                          Email failed
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td
                    className="px-4 py-2.5 text-right text-slate-500"
                    title={fmtTime(q.createdAt)}
                  >
                    {fmtAgo(q.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-slate-400">
        Every request the marketing site’s quote builder posts, with the number the desk gave it.
        The catalogue’s figures are the ones to quote from — a “price drift” flag means the page’s
        copy disagreed. Sending emails the quotation as a PDF; recording a yes and creating the
        client it becomes are the office’s own steps, priced from the quotation’s figures.
      </p>

      {createOpen ? (
        <Modal title="Create a quote" onClose={() => setCreateOpen(false)} size="lg">
          <div className="space-y-4">
            <p className="text-xs text-slate-500">
              For a prospect who called or emailed instead of using the website’s builder. It is
              priced by the same catalogue, and nothing is emailed until you send it.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={labelCls}>Business name</span>
                <input
                  value={createBusiness}
                  onChange={(e) => setCreateBusiness(e.target.value)}
                  className={inputCls}
                  placeholder="e.g. Kloof Auto Spares"
                />
              </label>
              <label className="block">
                <span className={labelCls}>Contact name</span>
                <input
                  value={createContactName}
                  onChange={(e) => setCreateContactName(e.target.value)}
                  className={inputCls}
                />
              </label>
              <label className="block">
                <span className={labelCls}>Email</span>
                <input
                  type="email"
                  value={createEmail}
                  onChange={(e) => setCreateEmail(e.target.value)}
                  className={inputCls}
                  placeholder="The quotation is sent here"
                />
              </label>
              <label className="block">
                <span className={labelCls}>Phone</span>
                <input
                  value={createPhone}
                  onChange={(e) => setCreatePhone(e.target.value)}
                  className={inputCls}
                />
              </label>
              <label className="block">
                <span className={labelCls}>Trade</span>
                <input
                  value={createVertical}
                  onChange={(e) => setCreateVertical(e.target.value)}
                  className={inputCls}
                  placeholder="e.g. spares"
                />
              </label>
              <label className="block">
                <span className={labelCls}>Note</span>
                <input
                  value={createNote}
                  onChange={(e) => setCreateNote(e.target.value)}
                  className={inputCls}
                  placeholder="Anything worth remembering"
                />
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block">
                <span className={labelCls}>Stores</span>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={createStores}
                  onChange={(e) => setCreateStores(e.target.value)}
                  className={inputCls}
                />
              </label>
              <label className="block">
                <span className={labelCls}>Tills per store</span>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={createTills}
                  onChange={(e) => setCreateTills(e.target.value)}
                  className={inputCls}
                />
                <span className="mt-1 block text-[11px] text-slate-400">
                  = {Number(createStores) * Number(createTills)} tills total
                </span>
              </label>
              <label className="block">
                <span className={labelCls}>Set-up</span>
                <select
                  value={createSetup}
                  onChange={(e) => setCreateSetup(e.target.value)}
                  className={inputCls}
                >
                  <option value="assisted">Assisted — R 5 000 once off</option>
                  <option value="self">Self — R 1 500 once off</option>
                </select>
              </label>
            </div>
            <div>
              <span className={labelCls}>Add-ons</span>
              <div className="flex flex-wrap gap-2">
                {soldAddons.map((feature) => {
                  const needsStores = feature.key === 'multi_store' && Number(createStores) < 2;
                  const on = createAddons.has(feature.key);
                  return (
                    <button
                      key={feature.key}
                      type="button"
                      disabled={needsStores}
                      onClick={() => toggleCreateAddon(feature.key)}
                      title={needsStores ? 'Needs two or more stores' : undefined}
                      className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                        on
                          ? 'border-brand-500 bg-brand-50 text-brand-700'
                          : 'border-slate-200 bg-white text-slate-500'
                      } ${needsStores ? 'cursor-not-allowed opacity-40' : ''}`}
                    >
                      {feature.label}
                    </button>
                  );
                })}
                {soldAddons.length === 0 ? (
                  <span className="text-xs text-slate-400">The vocabulary did not load.</span>
                ) : null}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => void createQuote()}
                disabled={createBusy}
                className={primaryBtn}
              >
                {createBusy ? 'Creating…' : 'Create quote'}
              </button>
              <button onClick={() => setCreateOpen(false)} className={secondaryBtn}>
                Cancel
              </button>
              <span className="text-[11px] text-slate-400">
                Priced by the catalogue; nothing is emailed until you send it.
              </span>
            </div>
            {createError ? <ErrorBox message={createError} /> : null}
          </div>
        </Modal>
      ) : null}

      {deleteOpen && detail ? (
        <Modal title={`Delete ${detail.number}?`} onClose={() => setDeleteOpen(false)}>
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              This removes the record for <strong>{detail.business || detail.email}</strong> — the
              request, its figures and its history. The number is retired, not reused, and the
              deletion is audited.
            </p>
            {deleteError ? <ErrorBox message={deleteError} /> : null}
            <div className="flex items-center gap-3">
              <button
                onClick={() => void deleteQuote()}
                disabled={deleteBusy}
                className={dangerBtn}
              >
                {deleteBusy ? 'Deleting…' : 'Delete quote'}
              </button>
              <button onClick={() => setDeleteOpen(false)} className={secondaryBtn}>
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      ) : detail ? (
        <Modal title={`Quote ${detail.number}`} onClose={() => setDetail(null)} size="lg">
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => void downloadPdf(detail)} className={secondaryBtn}>
                Download PDF
              </button>
              {detail.status === 'new' || detail.status === 'quoted' ? (
                <>
                  <button onClick={() => openSend(detail)} className={primaryBtn}>
                    {detail.status === 'quoted' ? 'Send again' : 'Send quotation'}
                  </button>
                  <button onClick={() => openEdit(detail)} className={secondaryBtn}>
                    Edit
                  </button>
                  <button
                    onClick={() => void recordOutcome('accept')}
                    disabled={outcomeBusy}
                    className={secondaryBtn}
                  >
                    Mark accepted
                  </button>
                  <button
                    onClick={() => void recordOutcome('decline')}
                    disabled={outcomeBusy}
                    className={secondaryBtn}
                  >
                    Mark declined
                  </button>
                </>
              ) : null}
              {detail.status === 'accepted' && detail.companyId === null ? (
                <button onClick={() => openClient(detail)} className={primaryBtn}>
                  Create client
                </button>
              ) : null}
              {detail.status === 'accepted' && detail.companyId !== null ? (
                <Link
                  to={`/clients/${detail.companyId}`}
                  className="text-xs font-bold text-brand-600 hover:underline"
                >
                  Open client {clientNames[detail.companyId] ?? `#${detail.companyId}`} →
                </Link>
              ) : null}
              {detail.status === 'quoted' && detail.sentAt ? (
                <span className="text-xs text-slate-500">
                  Sent {fmtTime(detail.sentAt)}
                  {detail.validUntil ? ` · valid until ${detail.validUntil}` : ''}
                </span>
              ) : null}
              {detail.status === 'accepted' && detail.acceptedAt ? (
                <span className="text-xs text-slate-500">
                  Accepted {fmtTime(detail.acceptedAt)}
                </span>
              ) : null}
              {detail.status === 'declined' && detail.declinedAt ? (
                <span className="text-xs text-slate-500">
                  Declined {fmtTime(detail.declinedAt)}
                </span>
              ) : null}
              {detail.companyId === null ? (
                <button
                  onClick={() => {
                    setDeleteError('');
                    setDeleteOpen(true);
                  }}
                  className={`ml-auto ${dangerBtn}`}
                >
                  Delete
                </button>
              ) : null}
            </div>
            {pdfError ? <ErrorBox message={pdfError} /> : null}
            {notice ? (
              <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm font-semibold text-green-800">
                {notice}
              </div>
            ) : null}
            {detail.expired ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                Expired on {detail.validUntil} — send it again to extend the validity.
              </div>
            ) : null}

            {sendOpen ? (
              <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/50 p-4">
                <div className="text-sm font-bold text-slate-800">
                  {detail.status === 'quoted' ? 'Send it again' : 'Send this quotation'}
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="block">
                    <span className={labelCls}>Stores</span>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={sendStores}
                      onChange={(e) => setSendStores(e.target.value)}
                      className={inputCls}
                    />
                  </label>
                  <label className="block">
                    <span className={labelCls}>Tills per store</span>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={sendTills}
                      onChange={(e) => setSendTills(e.target.value)}
                      className={inputCls}
                    />
                    <span className="mt-1 block text-[11px] text-slate-400">
                      = {Number(sendStores) * Number(sendTills)} tills total
                    </span>
                  </label>
                  <label className="block">
                    <span className={labelCls}>Set-up</span>
                    <select
                      value={sendSetup}
                      onChange={(e) => setSendSetup(e.target.value)}
                      className={inputCls}
                    >
                      <option value="assisted">Assisted — R 5 000 once off</option>
                      <option value="self">Self — R 1 500 once off</option>
                    </select>
                  </label>
                </div>
                <div>
                  <span className={labelCls}>Add-ons</span>
                  <div className="flex flex-wrap gap-2">
                    {soldAddons.map((feature) => {
                      const needsStores = feature.key === 'multi_store' && Number(sendStores) < 2;
                      const on = sendAddons.has(feature.key);
                      return (
                        <button
                          key={feature.key}
                          type="button"
                          disabled={needsStores}
                          onClick={() => toggleSendAddon(feature.key)}
                          title={needsStores ? 'Needs two or more stores' : undefined}
                          className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                            on
                              ? 'border-brand-500 bg-brand-50 text-brand-700'
                              : 'border-slate-200 bg-white text-slate-500'
                          } ${needsStores ? 'cursor-not-allowed opacity-40' : ''}`}
                        >
                          {feature.label}
                        </button>
                      );
                    })}
                    {soldAddons.length === 0 ? (
                      <span className="text-xs text-slate-400">The vocabulary did not load.</span>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    onClick={() => void sendQuote()}
                    disabled={sendBusy}
                    className={primaryBtn}
                  >
                    {sendBusy ? 'Sending…' : 'Send quotation as PDF'}
                  </button>
                  <button onClick={() => setSendOpen(false)} className={secondaryBtn}>
                    Cancel
                  </button>
                  <span className="text-[11px] text-slate-400">
                    Prices are re-priced from the catalogue; the validity window comes from
                    Settings.
                  </span>
                </div>
              </div>
            ) : null}

            {editOpen ? (
              <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/50 p-4">
                <div className="text-sm font-bold text-slate-800">Edit this quote</div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className={labelCls}>Business name</span>
                    <input
                      value={editBusiness}
                      onChange={(e) => setEditBusiness(e.target.value)}
                      className={inputCls}
                    />
                  </label>
                  <label className="block">
                    <span className={labelCls}>Contact name</span>
                    <input
                      value={editContactName}
                      onChange={(e) => setEditContactName(e.target.value)}
                      className={inputCls}
                    />
                  </label>
                  <label className="block">
                    <span className={labelCls}>Email</span>
                    <input
                      type="email"
                      value={editEmail}
                      onChange={(e) => setEditEmail(e.target.value)}
                      className={inputCls}
                    />
                  </label>
                  <label className="block">
                    <span className={labelCls}>Phone</span>
                    <input
                      value={editPhone}
                      onChange={(e) => setEditPhone(e.target.value)}
                      className={inputCls}
                    />
                  </label>
                  <label className="block">
                    <span className={labelCls}>Trade</span>
                    <input
                      value={editVertical}
                      onChange={(e) => setEditVertical(e.target.value)}
                      className={inputCls}
                    />
                  </label>
                  <label className="block">
                    <span className={labelCls}>Note</span>
                    <input
                      value={editNote}
                      onChange={(e) => setEditNote(e.target.value)}
                      className={inputCls}
                    />
                  </label>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="block">
                    <span className={labelCls}>Stores</span>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={editStores}
                      onChange={(e) => setEditStores(e.target.value)}
                      className={inputCls}
                    />
                  </label>
                  <label className="block">
                    <span className={labelCls}>Tills per store</span>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={editTills}
                      onChange={(e) => setEditTills(e.target.value)}
                      className={inputCls}
                    />
                    <span className="mt-1 block text-[11px] text-slate-400">
                      = {Number(editStores) * Number(editTills)} tills total
                    </span>
                  </label>
                  <label className="block">
                    <span className={labelCls}>Set-up</span>
                    <select
                      value={editSetup}
                      onChange={(e) => setEditSetup(e.target.value)}
                      className={inputCls}
                    >
                      <option value="assisted">Assisted — R 5 000 once off</option>
                      <option value="self">Self — R 1 500 once off</option>
                    </select>
                  </label>
                </div>
                <div>
                  <span className={labelCls}>Add-ons</span>
                  <div className="flex flex-wrap gap-2">
                    {soldAddons.map((feature) => {
                      const needsStores = feature.key === 'multi_store' && Number(editStores) < 2;
                      const on = editAddons.has(feature.key);
                      return (
                        <button
                          key={feature.key}
                          type="button"
                          disabled={needsStores}
                          onClick={() => toggleEditAddon(feature.key)}
                          title={needsStores ? 'Needs two or more stores' : undefined}
                          className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                            on
                              ? 'border-brand-500 bg-brand-50 text-brand-700'
                              : 'border-slate-200 bg-white text-slate-500'
                          } ${needsStores ? 'cursor-not-allowed opacity-40' : ''}`}
                        >
                          {feature.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    onClick={() => void saveEdit()}
                    disabled={editBusy}
                    className={primaryBtn}
                  >
                    {editBusy ? 'Saving…' : 'Save changes'}
                  </button>
                  <button onClick={() => setEditOpen(false)} className={secondaryBtn}>
                    Cancel
                  </button>
                  <span className="text-[11px] text-slate-400">
                    Saving re-prices from the catalogue; the visitor’s original figures are kept.
                  </span>
                </div>
                {editError ? <ErrorBox message={editError} /> : null}
              </div>
            ) : null}

            {clientOpen ? (
              <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/50 p-4">
                <div className="text-sm font-bold text-slate-800">
                  Create the client from this quote
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className={labelCls}>Client name</span>
                    <input
                      value={clientName}
                      onChange={(e) => setClientName(e.target.value)}
                      className={inputCls}
                    />
                  </label>
                  <label className="block">
                    <span className={labelCls}>Slug</span>
                    <input
                      value={clientSlug}
                      onChange={(e) => setClientSlug(e.target.value)}
                      className={inputCls}
                      placeholder="from the name"
                    />
                  </label>
                  <label className="block">
                    <span className={labelCls}>Plan</span>
                    <select
                      value={clientPlanId}
                      onChange={(e) => setClientPlanId(e.target.value)}
                      className={inputCls}
                    >
                      <option value="">No plan yet</option>
                      {plans.map((plan) => (
                        <option key={plan.id} value={String(plan.id)}>
                          {plan.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className={labelCls}>Licensed terminals</span>
                    <input
                      type="number"
                      min={0}
                      max={5000}
                      value={clientTills}
                      onChange={(e) => setClientTills(e.target.value)}
                      className={inputCls}
                    />
                  </label>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    onClick={() => void createClient()}
                    disabled={clientBusy}
                    className={primaryBtn}
                  >
                    {clientBusy ? 'Creating…' : 'Create client'}
                  </button>
                  <button onClick={() => setClientOpen(false)} className={secondaryBtn}>
                    Cancel
                  </button>
                  <span className="text-[11px] text-slate-400">
                    Priced from the quotation’s own figures —{' '}
                    {rand(detail.priced.monthlyTotalCents)} / month and{' '}
                    {rand(detail.priced.setupCents)} set-up.
                  </span>
                </div>
              </div>
            ) : null}

            {sendError ? <ErrorBox message={sendError} /> : null}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <SummaryTile label="Stores" value={detail.stores} />
              <SummaryTile label="Tills (total)" value={detail.tills} />
              <SummaryTile
                label="Monthly"
                value={rand(detail.priced.monthlyTotalCents)}
                tone="brand"
              />
              <SummaryTile label="Set-up, once off" value={rand(detail.priced.setupCents)} />
            </div>

            <div className="rounded-xl border border-slate-200 p-4 text-sm">
              <div className="font-semibold text-slate-800">{detail.business || 'a visitor'}</div>
              <div className="mt-0.5 text-slate-500">
                {detail.contactName || '—'} · {detail.email} · {detail.phone}
                {detail.vertical ? ` · ${detail.vertical}` : ''}
              </div>
              {detail.note ? (
                <p className="mt-2 whitespace-pre-line text-slate-600">{detail.note}</p>
              ) : null}
            </div>

            {detail.drift ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                The page showed different figures than the catalogue prices — the catalogue’s own
                figures are the ones to quote from.
              </div>
            ) : null}

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <div className="bg-slate-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  The quote they built
                </div>
                <table className="w-full text-xs">
                  <tbody>
                    {detail.requested.lines.map((line, index) => (
                      <tr key={index} className="border-t border-slate-100">
                        <td className="px-3 py-2 text-slate-600">{line.label}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                          {line.amount}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-t border-slate-100">
                      <td className="px-3 py-2 font-semibold text-slate-700">Monthly total</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-800">
                        {detail.requested.monthlyCents === null
                          ? '—'
                          : rand(detail.requested.monthlyCents)}
                      </td>
                    </tr>
                    <tr className="border-t border-slate-100">
                      <td className="px-3 py-2 text-slate-500">
                        {setupLabel(detail.setupVariant)}, once off
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                        {detail.requested.setupCents === null
                          ? '—'
                          : rand(detail.requested.setupCents)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="overflow-hidden rounded-xl border border-slate-200">
                <div className="bg-slate-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  The catalogue’s figures
                </div>
                <table className="w-full text-xs">
                  <tbody>
                    {detail.priced.lines.map((line, index) => (
                      <tr key={index} className="border-t border-slate-100">
                        <td className="px-3 py-2 text-slate-600">
                          {line.label}
                          {line.detail ? (
                            <span className="text-slate-400"> {line.detail}</span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                          {rand(line.cents)}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-t border-slate-100">
                      <td className="px-3 py-2 font-semibold text-slate-700">Monthly total</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-800">
                        {rand(detail.priced.monthlyTotalCents)}
                      </td>
                    </tr>
                    <tr className="border-t border-slate-100">
                      <td className="px-3 py-2 text-slate-500">
                        {setupLabel(detail.setupVariant)}, once off
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                        {rand(detail.priced.setupCents)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div className="text-xs text-slate-500">
              All figures are VAT-inclusive: the tax inside the monthly total is{' '}
              {rand(detail.priced.monthlyVatCents)} at {detail.vatRate}%, and{' '}
              {rand(detail.priced.setupVatCents)} of the set-up. Add-ons:{' '}
              {addonNames(detail) || 'none'}.
            </div>

            <div className="text-xs text-slate-500">
              {detail.source === 'office' ? (
                <>Drafted by the office {fmtTime(detail.createdAt)}</>
              ) : (
                <>
                  Received {fmtTime(detail.createdAt)}
                  {' · '}
                  {detail.emailedAt
                    ? `Emailed to the office ${fmtAgo(detail.emailedAt)}`
                    : 'Not emailed'}
                  {detail.emailError ? (
                    <span className="text-red-600"> — email failed: {detail.emailError}</span>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

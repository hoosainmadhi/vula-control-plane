import { Router } from 'express';
import {
  createCompany,
  createQuote,
  deleteQuote,
  getCompanyBySlug,
  getPlanById,
  getRegistryDb,
  getQuoteById,
  linkQuoteToCompany,
  listQuotes,
  listStores,
  markQuoteAccepted,
  markQuoteDeclined,
  markQuoteSent,
  recordAuditLog,
  setLicensedTerminalCount,
  setSubscriptionAddons,
  setSubscriptionPricing,
  updateQuoteContact,
  updateQuotePricing,
  type QuoteRecord,
} from '../config/registryDb.js';
import { requireOffice } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { HttpError } from '../utils/errors.js';
import { ValidationError, optionalString, requireInt, requireSlug } from '../utils/validate.js';
import { defaultMailRecipient, getRawOfficeSettings } from '../services/officeSettings.js';
import { buildQuotePdf, quotePdfFilename } from '../services/quotePdf.js';
import { DEFAULT_FEATURE_PRICES, validateFeatureDependencies } from '../services/features.js';
import {
  LIST_STORE_RATE_CENTS,
  LIST_TILL_RATE_CENTS,
  optionalTillsSplit,
  optionalRateCents,
  parseAddonKeys,
  parseAddonRates,
  parsePricingBasis,
  parseSetupVariant,
  priceQuote,
  resolveQuoteConfig,
  type QuoteConfig,
  type QuoteSetupVariant,
} from '../services/quotePricing.js';
import { sendQuoteDocument } from '../services/quoteMail.js';
import { orchestrateClientDeployment } from '../services/clientOrchestrator.js';

export const quotesRouter = Router();

/**
 * The quote's own pricing, as the office stated it: the basis, plus whichever
 * rates it overrode. Absent fields fall back to the row's own figures on an edit
 * and to the published list on a create — a quote carries only what the office
 * deliberately changed, so the difference is legible on the record and on the
 * desk. Sending `addonRates` (even empty) replaces the row's map; omitting it
 * keeps it.
 */
const quotePricingFrom = (
  body: Record<string, unknown>,
  existing?: QuoteRecord,
): {
  basis: 'store' | 'till';
  rates: {
    storeCents?: number;
    tillCents?: number;
    setupCents?: number;
    addonCents?: Record<string, number>;
  };
  /** The same figures, as the row stores them (null = the list's own). */
  record: {
    pricingBasis: 'store' | 'till';
    storeRateCents: number | null;
    tillRateCents: number | null;
    setupFeeOverrideCents: number | null;
    addonRates: Record<string, number>;
  };
} => {
  const basis =
    body['pricingBasis'] === undefined
      ? existing?.pricing_basis === 'till'
        ? ('till' as const)
        : ('store' as const)
      : parsePricingBasis(body['pricingBasis']);
  const storeCents =
    optionalRateCents(body, 'storeRateCents') ?? existing?.store_rate_cents ?? undefined;
  const tillCents =
    optionalRateCents(body, 'tillRateCents') ?? existing?.till_rate_cents ?? undefined;
  const setupCents =
    optionalRateCents(body, 'setupFeeOverrideCents') ??
    existing?.setup_fee_override_cents ??
    undefined;
  const storedAddons = (): Record<string, number> => {
    try {
      const parsed = JSON.parse(existing?.addon_rates_json ?? '{}') as Record<string, number>;
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  };
  const addonCents =
    body['addonRates'] === undefined ? storedAddons() : parseAddonRates(body['addonRates']);
  return {
    basis,
    rates: {
      ...(storeCents !== undefined ? { storeCents } : {}),
      ...(tillCents !== undefined ? { tillCents } : {}),
      ...(setupCents !== undefined ? { setupCents } : {}),
      ...(Object.keys(addonCents).length > 0 ? { addonCents } : {}),
    },
    record: {
      pricingBasis: basis,
      storeRateCents: storeCents ?? null,
      tillRateCents: tillCents ?? null,
      setupFeeOverrideCents: setupCents ?? null,
      addonRates: addonCents,
    },
  };
};

/**
 * The add-on unit prices a quote overrode, from its own snapshot. An unreadable
 * map is treated as empty — the published prices then apply, which is what the
 * record said before the field existed.
 */
const storedAddonRates = (quote: QuoteRecord): Record<string, number> => {
  try {
    const parsed = JSON.parse(quote.addon_rates_json) as Record<string, number>;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
};

// The desk holds prospect contact data and commercial figures — office only.
quotesRouter.use(requireOffice);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Today, UTC, `YYYY-MM-DD` — the clock the registry writes. */
const todayUtc = (): string => new Date().toISOString().slice(0, 10);

/**
 * Expiry is derived, never stored (the subscription-state rule): a quote that
 * was sent and whose validity has passed reads as expired — the record keeps
 * saying `quoted`, because that is what happened. Sending again extends it.
 */
const isExpired = (q: QuoteRecord): boolean =>
  q.status === 'quoted' && q.valid_until !== null && q.valid_until < todayUtc();

/** The quote a request names, or a 404 — every desk route starts the same way. */
const requireQuote = (idRaw: string): QuoteRecord => {
  const id = Number(idRaw);
  const quote = Number.isInteger(id) && id > 0 ? getQuoteById(id) : null;
  if (!quote) throw new HttpError(404, 'Quote not found');
  return quote;
};

/** A client's slug from a name — the derivation the plans page uses. */
const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * The per-store estate a quote describes.
 *
 * The desk stores a real split on the priced stores line (`split`, e.g.
 * [4, 3, 2]); without one the estate is the quote's own even multiplication.
 * When the operator changes the licensed total on conversion, the even split is
 * the only honest re-distribution — the quote's uneven shape belonged to the
 * quantity it was priced for.
 */
const quoteStoreSplit = (quote: QuoteRecord, licensedTotal: number): number[] => {
  const stores = Math.max(1, quote.stores);
  if (licensedTotal === quote.tills) {
    try {
      const lines = JSON.parse(quote.priced_lines_json) as Array<{ split?: unknown }>;
      const split = lines.find((line) => Array.isArray(line.split))?.split;
      if (
        Array.isArray(split) &&
        split.length === stores &&
        split.every((n) => Number.isInteger(n) && (n as number) >= 1)
      ) {
        return split as number[];
      }
    } catch {
      // An unreadable snapshot falls back to the even distribution below.
    }
  }
  const base = Math.floor(licensedTotal / stores);
  const remainder = licensedTotal % stores;
  return Array.from({ length: stores }, (_, i) => base + (i < remainder ? 1 : 0));
};

/** The store rows the quote becomes, with the wizard's own naming/URL defaults. */
const storesFromQuote = (
  quote: QuoteRecord,
  name: string,
  slug: string,
  split: number[],
): Array<{
  name: string;
  slug: string;
  baseUrl: string;
  kind: 'store';
  terminalCount: number;
  licensedTerminalCount: number;
  adminEmail?: string;
}> =>
  split.map((tills, i) => {
    const storeSlug = split.length === 1 ? slug : `${slug}-${i + 1}`;
    return {
      name: split.length === 1 ? name : `${name} Branch ${i + 1}`,
      slug: storeSlug,
      baseUrl: `https://${storeSlug}.vula-app.co.za`,
      kind: 'store' as const,
      terminalCount: tills,
      licensedTerminalCount: tills,
      ...(quote.email ? { adminEmail: quote.email } : {}),
    };
  });

/** The desk's view of a record: camelCase, JSON columns parsed, no DB names. */
const quoteOut = (q: QuoteRecord) => ({
  id: q.id,
  number: q.quote_number,
  status: q.status,
  /** Where it came from — the site's builder, or the office's own draft. */
  source: q.source,
  /** Derived from `valid_until` on a sent quote — never a stored status. */
  expired: isExpired(q),
  business: q.business,
  contactName: q.contact_name,
  email: q.email,
  phone: q.phone,
  vertical: q.vertical,
  note: q.note,
  stores: q.stores,
  tills: q.tills,
  addons: JSON.parse(q.addons_json) as string[],
  setupVariant: q.setup_variant,
  /**
   * The quote's own pricing: which basis it charges on, and the rates it
   * overrode. Null/empty is the published list — the desk shows the difference
   * so an off-list quote is visible as one (2026-10-14).
   */
  pricing: {
    basis: q.pricing_basis === 'till' ? 'till' : 'store',
    storeRateCents: q.store_rate_cents,
    tillRateCents: q.till_rate_cents,
    setupFeeOverrideCents: q.setup_fee_override_cents,
    addonRates: storedAddonRates(q),
  },
  requested: {
    lines: JSON.parse(q.requested_lines_json),
    monthlyCents: q.requested_monthly_cents,
    setupCents: q.requested_setup_cents,
  },
  priced: {
    lines: JSON.parse(q.priced_lines_json),
    monthlyTotalCents: q.monthly_total_cents,
    setupCents: q.setup_cents,
    monthlyVatCents: q.monthly_vat_cents,
    setupVatCents: q.setup_vat_cents,
  },
  vatRate: q.vat_rate,
  drift: Boolean(q.drift),
  emailedAt: q.emailed_at,
  emailError: q.email_error,
  validUntil: q.valid_until,
  sentAt: q.sent_at,
  acceptedAt: q.accepted_at,
  declinedAt: q.declined_at,
  companyId: q.company_id,
  createdAt: q.created_at,
  updatedAt: q.updated_at,
});

const QUOTE_STATUSES = ['new', 'quoted', 'accepted', 'declined'];

quotesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    if (status && !QUOTE_STATUSES.includes(status)) {
      throw new ValidationError(`Unknown quote status '${status}'`);
    }
    res.json({ ok: true, quotes: listQuotes(status || undefined).map(quoteOut) });
  }),
);

/**
 * The office drafts a quote itself — for someone who called or emailed instead
 * of using the site's builder. Same record, same pipeline: priced by the same
 * catalogue, with no `requested_*` (there was no page to disagree with) and no
 * request email to send — the desk is where it was born.
 */
quotesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const business = (optionalString(body, 'business', 120) ?? '').trim();
    if (!business) throw new ValidationError('Give the quote a business name');
    const email = (optionalString(body, 'email', 254) ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      throw new ValidationError(
        'That email address does not look right — the quotation is sent to it',
      );
    }
    // A real per-store split sets both counts; without one the even pair is the
    // configuration, and is required.
    const split = optionalTillsSplit(body);
    const pricing = quotePricingFrom(body);
    const config: QuoteConfig = {
      stores: split ? split.length : requireInt(body, 'stores', { min: 1, max: 50 }),
      tills: split
        ? split.reduce((sum, tills) => sum + tills, 0)
        : requireInt(body, 'tills', { min: 1, max: 500 }),
      addons: parseAddonKeys(body['addons']),
      setup: parseSetupVariant(body['setup']),
      basis: pricing.basis,
      rates: pricing.rates,
      ...(split ? { tillsSplit: split } : {}),
    };
    const priced = priceQuote(config, getRawOfficeSettings().vat_rate);
    const record = createQuote({
      source: 'office',
      business,
      contactName: (optionalString(body, 'contactName', 120) ?? '').trim(),
      email,
      phone: (optionalString(body, 'phone', 40) ?? '').trim(),
      vertical: (optionalString(body, 'vertical', 40) ?? '').trim(),
      note: (optionalString(body, 'note', 2000) ?? '').trim(),
      stores: config.stores,
      tills: config.tills,
      addons: config.addons,
      setupVariant: config.setup,
      ...pricing.record,
      requestedLines: [],
      requestedMonthlyCents: null,
      requestedSetupCents: null,
      pricedLines: priced.lines,
      monthlyTotalCents: priced.monthlyTotalCents,
      setupCents: priced.setupCents,
      vatRate: priced.vatRate,
      monthlyVatCents: priced.monthlyVatCents,
      setupVatCents: priced.setupVatCents,
      drift: 0,
    });
    recordAuditLog('office', 'quote_created', 'quote', record.id, {
      after: {
        number: record.quote_number,
        business,
        stores: config.stores,
        tills: config.tills,
        addons: config.addons,
        monthlyTotalCents: priced.monthlyTotalCents,
      },
      reason: `Drafted ${record.quote_number} for ${business}`,
    });
    res.status(201).json({ ok: true, quote: quoteOut(record) });
  }),
);

/**
 * The office corrects a draft or a sent quote: the prospect's details and the
 * configuration. An explicit configuration field re-prices from the catalogue
 * (the visitor's `requested_*` snapshot is never rewritten — it is what they
 * were shown, not a value to keep in step). A settled quote is not edited.
 */
quotesRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const quote = requireQuote(req.params.id);
    if (quote.status !== 'new' && quote.status !== 'quoted') {
      throw new HttpError(
        409,
        `Quote ${quote.quote_number} is ${quote.status} — a settled quote is not edited`,
      );
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = (key: string, max: number): string | undefined =>
      body[key] === undefined ? undefined : (optionalString(body, key, max) ?? '').trim();
    const business = text('business', 120);
    if (business !== undefined && !business) {
      throw new ValidationError('Give the quote a business name');
    }
    const email = text('email', 254)?.toLowerCase();
    if (email !== undefined && !EMAIL_RE.test(email)) {
      throw new ValidationError(
        'That email address does not look right — the quotation is sent to it',
      );
    }
    const contactName = text('contactName', 120);
    const phone = text('phone', 40);
    const vertical = text('vertical', 40);
    const note = text('note', 2000);

    let current = quote;
    const splitSent = body['tillsSplit'] !== undefined;
    const pricing = quotePricingFrom(body, quote);
    if (
      splitSent ||
      ['stores', 'tills', 'addons', 'setup'].some((key) => body[key] !== undefined) ||
      // The quote's own pricing counts as a correction too (2026-10-14).
      [
        'pricingBasis',
        'storeRateCents',
        'tillRateCents',
        'setupFeeOverrideCents',
        'addonRates',
      ].some((key) => body[key] !== undefined)
    ) {
      const config: QuoteConfig = {
        basis: pricing.basis,
        rates: pricing.rates,
        stores:
          body['stores'] !== undefined
            ? requireInt(body, 'stores', { min: 1, max: 50 })
            : quote.stores,
        tills:
          body['tills'] !== undefined
            ? requireInt(body, 'tills', { min: 1, max: 500 })
            : quote.tills,
        addons:
          body['addons'] !== undefined
            ? parseAddonKeys(body['addons'])
            : (JSON.parse(quote.addons_json) as string[]),
        setup:
          body['setup'] !== undefined
            ? parseSetupVariant(body['setup'])
            : (quote.setup_variant as QuoteSetupVariant),
        // A sent split is the truth and overrides the even counts; an edit that
        // sends only even counts clears any split the record held.
        tillsSplit: optionalTillsSplit(body),
      };
      const priced = priceQuote(config, getRawOfficeSettings().vat_rate);
      const resolved = resolveQuoteConfig(config);
      current = updateQuotePricing(quote.id, {
        stores: resolved.stores,
        tills: resolved.tills,
        addons: resolved.addons,
        setupVariant: resolved.setup,
        pricedLines: priced.lines,
        monthlyTotalCents: priced.monthlyTotalCents,
        setupCents: priced.setupCents,
        vatRate: priced.vatRate,
        monthlyVatCents: priced.monthlyVatCents,
        setupVatCents: priced.setupVatCents,
      });
    }

    if ([business, contactName, email, phone, vertical, note].some((v) => v !== undefined)) {
      current = updateQuoteContact(quote.id, {
        business: business ?? current.business,
        contactName: contactName ?? current.contact_name,
        email: email ?? current.email,
        phone: phone ?? current.phone,
        vertical: vertical ?? current.vertical,
        note: note ?? current.note,
      });
    }

    recordAuditLog('office', 'quote_updated', 'quote', quote.id, {
      after: {
        number: current.quote_number,
        business: current.business,
        email: current.email,
        stores: current.stores,
        tills: current.tills,
        monthlyTotalCents: current.monthly_total_cents,
      },
      reason: `Edited ${current.quote_number}`,
    });
    res.json({ ok: true, quote: quoteOut(current) });
  }),
);

/**
 * Removes a quote that never became a client. The client link is the guard: a
 * converted quote is part of that client's story and stays. Deleting is
 * audited, and the number is retired rather than reused (the sequence only
 * moves forward).
 */
quotesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const quote = requireQuote(req.params.id);
    if (quote.company_id !== null) {
      throw new HttpError(
        409,
        `Quote ${quote.quote_number} became client ${quote.company_id} — that link is part of the client's story`,
      );
    }
    deleteQuote(quote.id);
    recordAuditLog('office', 'quote_deleted', 'quote', quote.id, {
      after: {
        number: quote.quote_number,
        business: quote.business || quote.email,
        status: quote.status,
      },
      reason: `Deleted ${quote.quote_number}`,
    });
    res.json({ ok: true });
  }),
);

quotesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const quote = requireQuote(req.params.id);
    res.json({ ok: true, quote: quoteOut(quote) });
  }),
);

quotesRouter.get(
  '/:id/pdf',
  asyncHandler(async (req, res) => {
    const quote = requireQuote(req.params.id);
    // The same builder the send action attaches, so what the office downloads
    // and what the prospect receives cannot drift apart.
    const pdf = await buildQuotePdf({ quote, settings: getRawOfficeSettings() });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${quotePdfFilename(quote)}"`);
    res.send(pdf);
  }),
);

quotesRouter.post(
  '/:id/send',
  asyncHandler(async (req, res) => {
    const quote = requireQuote(req.params.id);
    if (quote.status !== 'new' && quote.status !== 'quoted') {
      throw new HttpError(
        409,
        `Quote ${quote.quote_number} is already ${quote.status} — a settled quote is not re-sent.`,
      );
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    // The office may correct the configuration before sending — the marketing
    // page itself tells a prospect to send its real split, and the desk can now
    // state it. Only an explicit field re-prices; an untouched send keeps the
    // record's snapshot.
    let current = quote;
    const splitSent = body['tillsSplit'] !== undefined;
    const pricing = quotePricingFrom(body, quote);
    if (
      splitSent ||
      ['stores', 'tills', 'addons', 'setup'].some((key) => body[key] !== undefined) ||
      // The quote's own pricing counts as a correction too (2026-10-14).
      [
        'pricingBasis',
        'storeRateCents',
        'tillRateCents',
        'setupFeeOverrideCents',
        'addonRates',
      ].some((key) => body[key] !== undefined)
    ) {
      const office = getRawOfficeSettings();
      const config: QuoteConfig = {
        stores:
          body['stores'] !== undefined
            ? requireInt(body, 'stores', { min: 1, max: 50 })
            : quote.stores,
        tills:
          body['tills'] !== undefined
            ? requireInt(body, 'tills', { min: 1, max: 500 })
            : quote.tills,
        addons:
          body['addons'] !== undefined
            ? parseAddonKeys(body['addons'])
            : (JSON.parse(quote.addons_json) as string[]),
        setup:
          body['setup'] !== undefined
            ? parseSetupVariant(body['setup'])
            : (quote.setup_variant as QuoteSetupVariant),
        // A sent split is the truth and overrides the even counts; sending only
        // even counts clears any split the record held.
        tillsSplit: optionalTillsSplit(body),
      };
      const priced = priceQuote(config, office.vat_rate);
      const resolved = resolveQuoteConfig(config);
      current = updateQuotePricing(quote.id, {
        stores: resolved.stores,
        tills: resolved.tills,
        addons: resolved.addons,
        setupVariant: resolved.setup,
        ...pricing.record,
        pricedLines: priced.lines,
        monthlyTotalCents: priced.monthlyTotalCents,
        setupCents: priced.setupCents,
        vatRate: priced.vatRate,
        monthlyVatCents: priced.monthlyVatCents,
        setupVatCents: priced.setupVatCents,
      });
    }

    const office = getRawOfficeSettings();
    const validDays =
      body['validDays'] !== undefined
        ? requireInt(body, 'validDays', { min: 1, max: 180 })
        : office.quote_valid_days;
    // Today + N days, UTC — the same clock the registry writes.
    const validUntil = new Date(Date.now() + validDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const pdf = await buildQuotePdf({ quote: current, settings: office });
    try {
      await sendQuoteDocument(
        {
          number: current.quote_number,
          business: current.business,
          contactName: current.contact_name,
          email: current.email,
          officeName: office.office_name,
          replyTo: defaultMailRecipient(office) || undefined,
          monthlyTotalCents: current.monthly_total_cents,
          setupCents: current.setup_cents,
          validUntil,
        },
        pdf,
      );
    } catch (err) {
      // A refused or unconfigured send is a failure, and the trail says so — an
      // `ok` audit row for a document nobody received is the fabricated success
      // the invoice email route used to hand back.
      recordAuditLog('office', 'quote_sent', 'quote', quote.id, {
        after: { number: quote.quote_number, recipient: quote.email },
        reason: err instanceof Error ? err.message : String(err),
        result: 'failed',
      });
      throw err;
    }

    const updated = markQuoteSent(quote.id, validUntil);
    recordAuditLog('office', 'quote_sent', 'quote', quote.id, {
      after: { number: updated.quote_number, recipient: updated.email, validUntil },
      reason: `Quotation emailed to ${updated.email}`,
    });
    res.json({ ok: true, quote: quoteOut(updated) });
  }),
);

/** Records the office's outcome: the prospect said yes or no. */
quotesRouter.post(
  '/:id/accept',
  asyncHandler(async (req, res) => {
    const quote = requireQuote(req.params.id);
    if (quote.status === 'accepted') {
      throw new HttpError(409, `Quote ${quote.quote_number} is already accepted`);
    }
    if (quote.status === 'declined') {
      throw new HttpError(
        409,
        `Quote ${quote.quote_number} was declined — a fresh request is a fresh quote`,
      );
    }
    const updated = markQuoteAccepted(quote.id);
    recordAuditLog('office', 'quote_accepted', 'quote', quote.id, {
      before: { status: quote.status },
      after: { number: updated.quote_number, business: updated.business || updated.email },
      reason: `Recorded the acceptance of ${updated.quote_number}`,
    });
    res.json({ ok: true, quote: quoteOut(updated) });
  }),
);

quotesRouter.post(
  '/:id/decline',
  asyncHandler(async (req, res) => {
    const quote = requireQuote(req.params.id);
    if (quote.status === 'declined') {
      throw new HttpError(409, `Quote ${quote.quote_number} is already declined`);
    }
    if (quote.status === 'accepted') {
      throw new HttpError(409, `Quote ${quote.quote_number} is already accepted`);
    }
    const updated = markQuoteDeclined(quote.id);
    recordAuditLog('office', 'quote_declined', 'quote', quote.id, {
      before: { status: quote.status },
      after: { number: updated.quote_number, business: updated.business || updated.email },
      reason: `Recorded the decline of ${updated.quote_number}`,
    });
    res.json({ ok: true, quote: quoteOut(updated) });
  }),
);

/**
 * The client the quote becomes. The panel pre-fills every field from the
 * record; the office confirms or corrects. The subscription is priced from the
 * **quote's own figures**, not the plan's: the quotation is the promise, and a
 * price edited since must not rewrite what this client agreed — the same
 * grandfathering every other agreed price gets (P4's served list closes the
 * loop between the desk and the plan).
 */
quotesRouter.post(
  '/:id/create-client',
  asyncHandler(async (req, res) => {
    const quote = requireQuote(req.params.id);
    if (quote.status !== 'accepted') {
      throw new HttpError(
        409,
        `Quote ${quote.quote_number} is ${quote.status} — record the acceptance before creating the client`,
      );
    }
    if (quote.company_id !== null) {
      throw new HttpError(
        409,
        `Quote ${quote.quote_number} is already linked to company ${quote.company_id}`,
      );
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = (optionalString(body, 'name', 120) ?? quote.business).trim();
    if (!name) {
      throw new ValidationError('A client needs a name — type one in, the request came without it');
    }
    // One validator for both paths: a typed slug, or the derivation from the name.
    const typedSlug = typeof body['slug'] === 'string' ? body['slug'].trim() : '';
    const slug = requireSlug({ slug: typedSlug || slugify(name) });
    if (getCompanyBySlug(slug)) {
      throw new HttpError(409, `A company with slug "${slug}" already exists — choose another`);
    }

    const planIdRaw = body['planId'];
    const planId = planIdRaw === undefined || planIdRaw === null ? null : Number(planIdRaw);
    const plan = planId === null ? null : getPlanById(planId);
    if (planId !== null && !plan) throw new ValidationError('planId does not match a known plan');
    if (plan && !plan.is_active) {
      throw new ValidationError(`Plan "${plan.name}" is inactive and cannot be used`);
    }
    const licensedTerminalCount =
      body['licensedTerminalCount'] !== undefined
        ? requireInt(body, 'licensedTerminalCount', { min: 0, max: 5000 })
        : quote.tills;
    if (licensedTerminalCount < quote.stores) {
      throw new ValidationError(
        `Every store runs at least one till — ${quote.stores} stores need ${quote.stores} licensed terminals or more`,
      );
    }

    // The estate the quote describes. A real per-store split travels on the
    // priced stores line; without one the quote's own even multiplication does.
    const split = quoteStoreSplit(quote, licensedTerminalCount);
    if (split.length !== quote.stores || split.some((tills) => tills < 1)) {
      throw new ValidationError('The quote does not describe a usable per-store estate');
    }

    // A plan's caps are part of what it sells, so they are checked before
    // anything is created. `max_stores` mirrors `POST /stores`; the per-store
    // ceiling is the signed licence's `maxTerminals`.
    if (plan) {
      if (quote.stores > plan.max_stores) {
        throw new HttpError(
          400,
          `${plan.name} allows ${plan.max_stores} store${plan.max_stores === 1 ? '' : 's'}, but this quote describes ${quote.stores}. Choose a plan with a higher store cap.`,
        );
      }
      const ceiling = Math.max(...split);
      if (ceiling > plan.max_terminals_per_store) {
        throw new HttpError(
          400,
          `${plan.name} allows ${plan.max_terminals_per_store} terminal${plan.max_terminals_per_store === 1 ? '' : 's'} per store, but the quote has a branch with ${ceiling}. Choose a plan with a higher per-store ceiling.`,
        );
      }
    }

    const addons = JSON.parse(quote.addons_json) as string[];
    // A quote written before AI Copilot became Head Office-only can still be
    // accepted; it must not become a client that holds AI without the panel.
    validateFeatureDependencies(addons);
    const hasHeadOffice = addons.includes('multi_store');
    const stores = storesFromQuote(quote, name, slug, split);
    const headOffice = hasHeadOffice
      ? {
          name: `${name} Head Office`,
          slug: `${slug}-ho`,
          baseUrl: `https://${slug}-ho.vula-app.co.za`,
          ...(quote.email ? { adminEmail: quote.email } : {}),
        }
      : undefined;

    // The rows are ours to create, so a clashing slug is named now rather than
    // discovered halfway through a deployment job.
    const existingStoreSlugs = new Set(listStores().map((store) => store.slug));
    const clash = stores.find((store) => existingStoreSlugs.has(store.slug));
    if (clash) {
      throw new HttpError(409, `A store with slug "${clash.slug}" already exists — choose another`);
    }
    if (headOffice) {
      const panelClash = getRegistryDb()
        .prepare('SELECT id FROM panels WHERE slug = ?')
        .get(headOffice.slug);
      if (panelClash) {
        throw new HttpError(
          409,
          `A Head Office with slug "${headOffice.slug}" already exists — choose another client slug`,
        );
      }
    }

    // THE QUOTE'S OWN FIGURES, never the published list's (2026-10-14). The
    // quotation is the promise: a quote priced per till, or carrying an overridden
    // rate, becomes a client on exactly those terms. Reading the list here billed
    // a per-store client a store rate of ZERO (found the day the list moved per
    // store) and would have dropped any override in the same way. The plan still
    // supplies the caps, the features and the billing period — never the price.
    const basis: 'store' | 'till' = quote.pricing_basis === 'till' ? 'till' : 'store';
    const storeRateCents = quote.store_rate_cents ?? LIST_STORE_RATE_CENTS;
    const tillRateCents = quote.till_rate_cents ?? LIST_TILL_RATE_CENTS;
    const addonRates: Record<string, number> = {
      ...DEFAULT_FEATURE_PRICES,
      ...storedAddonRates(quote),
    };
    const addonPrices = Object.fromEntries(addons.map((key) => [key, addonRates[key] ?? 0]));

    // One transaction for the commercial record: company, purchased quantity,
    // agreed terms, add-ons and the quote link. The deployment job follows.
    const company = getRegistryDb().transaction(() => {
      const created = createCompany({
        name,
        slug,
        billingEmail: quote.email,
        planId,
        paidThrough: null,
        trialEndsAt: null,
      });
      setLicensedTerminalCount(created.id, licensedTerminalCount);
      setSubscriptionPricing(created.id, {
        pricingMode: basis === 'till' ? 'per_terminal' : 'per_store',
        rateCents: tillRateCents,
        storeRateCents: basis === 'till' ? 0 : storeRateCents,
        customAmountCents: 0,
        setupFeeCents: quote.setup_cents,
        billingPeriod: plan?.billing_period ?? 'monthly',
      });
      setSubscriptionAddons(created.id, addons, addonPrices);
      linkQuoteToCompany(quote.id, created.id);
      recordAuditLog('office', 'quote_client_created', 'quote', quote.id, {
        after: {
          number: quote.quote_number,
          companyId: created.id,
          name,
          slug,
          planCode: plan?.code ?? null,
          licensedTerminalCount,
          stores: split.length,
          tillsSplit: split,
          pricingBasis: basis,
          rateCents: tillRateCents,
          storeRateCents: basis === 'till' ? 0 : storeRateCents,
          addonPrices,
          setupFeeCents: quote.setup_cents,
          headOffice: Boolean(headOffice),
        },
        reason: `Created client "${name}" from ${quote.quote_number}`,
      });
      return created;
    })();

    // The quote becomes the estate it priced: branches with their licensed
    // counts, and a Head Office when the quote bought the add-on. Without this
    // the client's store count was zero, so the recurring quote priced every till
    // as an additional one until someone built the branches by hand.
    const { job, steps } = await orchestrateClientDeployment({
      companyId: company.id,
      deploymentType: headOffice ? 'multi_store' : 'single_store',
      stores,
      headOffice,
      autoDeploy: body['autoDeploy'] !== false,
    });

    const linked = getQuoteById(quote.id)!;
    res.status(201).json({
      ok: true,
      quote: quoteOut(linked),
      company: { id: company.id, name: company.name, slug: company.slug },
      deployment: { job, steps },
    });
  }),
);

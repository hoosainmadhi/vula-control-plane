/**
 * The one public, unauthenticated surface on the control plane: the marketing
 * site's quote request.
 *
 * Everything else here is behind the office login or a control-plane token. This
 * is deliberately not: the visitor is a stranger on a static page, and the page
 * cannot send mail. So the endpoint is treated as hostile by default —
 *
 *  - **it sends to us and to the visitor, never to an address the caller chose.**
 *    There is no "to" field on the wire; the office address is config (`QUOTE_TO`)
 *    and the visitor's own address is one they typed. Nothing here can be pointed
 *    at a third party to relay mail through our domain.
 *  - **rate-limited per source address**, so one script cannot use it as a mail
 *    cannon aimed at a stranger's inbox (the visitor's address is on the message,
 *    so an attacker's victim would receive the copies).
 *  - **a honeypot field**, because a form on the open internet is a bot target and
 *    a bot that fills every field is the cheapest signal there is. Filled means
 *    "ok" to the bot and nothing sent.
 *  - **length-capped and shape-checked** before anything is composed, and the
 *    composer escapes everything it prints.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { optionalString, requireString, ValidationError } from '../utils/validate.js';
import { rateLimiter } from '../utils/rateLimiter.js';
import { sendQuoteRequest, type QuoteLine } from '../services/quoteMail.js';
import { logger } from '../utils/logger.js';

export const publicRouter = Router();

/** Where the office wants quote requests. */
const quoteTo = (): string => (process.env.QUOTE_TO ?? '').trim() || 'hello@vula-app.co.za';

/**
 * Who may call this from a browser. The marketing site is a different origin from
 * the control plane, so the browser needs permission — and only that site is
 * given it: a wildcard would let any page on the internet post here.
 */
const ALLOWED_ORIGINS = new Set([
  'https://vula-app.co.za',
  'https://www.vula-app.co.za',
  // The site's own dev and preview servers, so the form can be exercised locally.
  'http://localhost:3232',
  'http://localhost:3233',
  'http://127.0.0.1:3232',
  'http://127.0.0.1:3233',
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** CORS for this router only: POST with a JSON body, from the site. */
publicRouter.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.get('origin');
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

const money = (raw: unknown): string => {
  const value = typeof raw === 'string' ? raw.trim() : '';
  // The page formats prices; this only refuses anything that is not price-shaped,
  // so nothing arbitrary rides into the email through a field called "amount".
  if (!value || value.length > 24 || !/^R?\s?[\d\s.,]+$/.test(value)) {
    throw new ValidationError('Each line needs an amount');
  }
  return value;
};

const quoteLine = (raw: unknown): QuoteLine => {
  const row = (raw ?? {}) as Record<string, unknown>;
  const label = typeof row.label === 'string' ? row.label.trim() : '';
  if (!label) throw new ValidationError('Each line needs a label');
  if (label.length > 120) throw new ValidationError('A line label is too long');
  return { label, amount: money(row.amount) };
};

/** Whole numbers the page's own controls can produce, and nothing wilder. */
const boundedInt = (raw: unknown, min: number, max: number, label: string): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${label} must be a whole number between ${min} and ${max}`);
  }
  return value;
};

publicRouter.post(
  '/quote-request',
  rateLimiter({ windowMs: 60 * 60 * 1000, max: 5, label: 'quote-request' }),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Honeypot: a field the form hides from people and a bot fills in. Answer as
    // if it worked — a bot that learns it was caught comes back differently.
    if (typeof body.website === 'string' && body.website.trim() !== '') {
      logger.info('Quote request discarded: honeypot filled');
      res.json({ ok: true });
      return;
    }

    const email = requireString(body, 'email', 254).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      throw new ValidationError('That email address does not look right');
    }
    // A mobile number is the point of the form — it is how the office answers —
    // so it is required, and checked only for the shape that matters: enough
    // digits to be a phone number, and nothing else strange in a header.
    const phone = requireString(body, 'phone', 40).trim();
    if (!/[0-9]{6,}/.test(phone.replace(/[^0-9]/g, '')) || /[^0-9+()\s-]/.test(phone)) {
      throw new ValidationError('Please give a mobile number we can reach you on');
    }
    const linesRaw = Array.isArray(body.lines) ? body.lines : [];
    if (linesRaw.length === 0 || linesRaw.length > 20) {
      throw new ValidationError('A quote needs between 1 and 20 lines');
    }

    const input = {
      to: quoteTo(),
      business: optionalString(body, 'business', 120)?.trim() ?? '',
      name: optionalString(body, 'name', 120)?.trim() ?? '',
      email,
      phone,
      // Free text, capped: the select offers the product's own trades, and a
      // form post is not obliged to have used it.
      vertical: optionalString(body, 'vertical', 40)?.trim() ?? '',
      note: optionalString(body, 'note', 2000)?.trim() ?? '',
      stores: boundedInt(body.stores, 1, 50, 'stores'),
      tills: boundedInt(body.tills, 1, 50, 'tills'),
      lines: linesRaw.map(quoteLine),
      monthlyTotal: money(body.monthlyTotal),
      setupLabel: optionalString(body, 'setupLabel', 120)?.trim() || 'Set-up, once off',
      setupAmount: money(body.setupAmount),
    };

    try {
      await sendQuoteRequest(input);
    } catch (err) {
      // The page shows this and offers the visitor their own mail app instead, so
      // it says what happened without leaking anything about the transport.
      logger.warn(`Quote request could not be sent: ${err instanceof Error ? err.message : err}`);
      res.status(502).json({
        error: 'We could not send that just now. Please try again, or email us directly.',
        code: 'quote_send_failed',
      });
      return;
    }

    logger.info(`Quote request sent for ${input.business || input.email} (${input.email})`);
    res.json({ ok: true });
  }),
);

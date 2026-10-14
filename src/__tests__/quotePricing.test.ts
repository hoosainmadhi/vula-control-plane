import {
  parseMoneyCents,
  priceQuote,
  SETUP_FEE_CENTS,
  validateQuoteConfig,
  type QuoteConfig,
} from '../services/quotePricing.js';

const base: QuoteConfig = {
  stores: 3,
  tills: 6,
  addons: ['multi_store', 'customer_credit'],
  setup: 'assisted',
};

describe('quote pricing', () => {
  it("prices the stores and their additional tills plus the add-ons, in the vocabulary's order", () => {
    const priced = priceQuote(base, 15);
    expect(priced.lines).toEqual([
      {
        label: '3 stores',
        detail: 'first till included · (2 tills per store)',
        cents: 59700,
        rateCents: 19_900,
        quantity: 3,
      },
      {
        label: '3 additional tills',
        detail: '',
        cents: 14700,
        rateCents: 4_900,
        quantity: 3,
      },
      // The add-ons are per-store capabilities: three stores' worth of credit
      // accounts. Head Office is the one per-company add-on — one panel.
      { label: 'Head Office', detail: '', cents: 19_900, rateCents: 19_900, quantity: 1 },
      { label: 'Credit accounts', detail: '', cents: 14_700, rateCents: 4900, quantity: 3 },
    ]);
    expect(priced.monthlyTotalCents).toBe(109_000);
    expect(priced.setupCents).toBe(SETUP_FEE_CENTS.assisted);
  });

  it('breaks the VAT out of the inclusive figures without losing a cent', () => {
    const priced = priceQuote(base, 15);
    expect(priced.monthlyTotalCents - priced.monthlyVatCents).toBe(94_783);
    expect(priced.monthlyVatCents).toBe(14_217);
    expect(priced.setupVatCents).toBe(65217);
    expect(priced.setupCents - priced.setupVatCents).toBe(434783);
  });

  it('refuses Head Office on a single-store quote', () => {
    expect(() =>
      validateQuoteConfig({ stores: 1, tills: 2, addons: ['multi_store'], setup: 'assisted' }),
    ).toThrow(/two or more stores/i);
  });

  it('refuses an add-on the vocabulary does not know', () => {
    expect(() => validateQuoteConfig({ ...base, addons: ['free_lunch'] })).toThrow(
      /unknown add-on/i,
    );
  });

  it('prices an add-on sent twice once', () => {
    const priced = priceQuote({ ...base, addons: ['layby', 'layby'] }, 15);
    expect(priced.lines.filter((line) => line.label === 'Lay-by')).toHaveLength(1);
  });

  it('charges the per-company add-ons once, however many stores there are (2026-10-14)', () => {
    // Head Office and the e-commerce bridges are one thing for the business; the
    // rest are per-store capabilities. Owner: "ecommerce should be for the whole
    // business and not per store".
    const priced = priceQuote(
      { stores: 3, tills: 3, addons: ['multi_store', 'layby', 'ecommerce_bridges'], setup: 'self' },
      15,
    );
    const line = (label: string) => priced.lines.find((l) => l.label === label)!;
    expect(line('Head Office')).toMatchObject({ cents: 19_900, rateCents: 19_900, quantity: 1 });
    expect(line('E-commerce')).toMatchObject({ cents: 4900, rateCents: 4900, quantity: 1 });
    // A per-store capability on the same quote still multiplies.
    expect(line('Lay-by')).toMatchObject({ cents: 14_700, rateCents: 4900, quantity: 3 });
    // Three stores (first till in each) + the two per-company add-ons + 3 × lay-by.
    expect(priced.monthlyTotalCents).toBe(3 * 19_900 + 19_900 + 4900 + 3 * 4900);
  });

  it('keeps the stores line plain when the tills do not divide evenly', () => {
    // 7 tills across 3 stores: no per-store claim to make — the stores line says
    // what it is, and the 4 tills beyond the included first ones price as
    // additional ones.
    const priced = priceQuote({ stores: 3, tills: 7, addons: [], setup: 'self' }, 15);
    expect(priced.lines[0]).toEqual({
      label: '3 stores',
      detail: 'first till included',
      cents: 59700,
      rateCents: 19_900,
      quantity: 3,
    });
    expect(priced.lines[1]).toEqual({
      label: '4 additional tills',
      detail: '',
      cents: 19600,
      rateCents: 4_900,
      quantity: 4,
    });
    expect(priced.monthlyTotalCents).toBe(79_300);
    expect(priced.setupCents).toBe(SETUP_FEE_CENTS.self);
  });

  it('leaves the split off a single-store quote — there is nothing to split', () => {
    const priced = priceQuote({ stores: 1, tills: 2, addons: [], setup: 'self' }, 15);
    expect(priced.lines[0]).toEqual({
      label: '1 store',
      detail: 'first till included',
      cents: 19_900,
      rateCents: 19_900,
      quantity: 1,
    });
    expect(priced.lines[1]).toEqual({
      label: '1 additional till',
      detail: '',
      cents: 4_900,
      rateCents: 4_900,
      quantity: 1,
    });
  });

  it('states a real per-store split as itself, deriving the counts from the list', () => {
    // The even counts beside the split are ignored: the list is what the office
    // knows — 2 tills at one store, 3 at the next, 1 at the last.
    const priced = priceQuote(
      { stores: 9, tills: 9, addons: [], setup: 'self', tillsSplit: [2, 3, 1] },
      15,
    );
    expect(priced.lines[0]).toEqual({
      label: '3 stores',
      detail: 'first till included · (2 + 3 + 1 across 3 stores)',
      cents: 59700,
      rateCents: 19_900,
      quantity: 3,
      split: [2, 3, 1],
    });
    // The tills beyond each store's included first one, store by store.
    expect(priced.lines[1]).toEqual({
      label: '3 additional tills',
      detail: '(1 + 2 + 0 extra across 3 stores)',
      cents: 14700,
      rateCents: 4_900,
      quantity: 3,
    });
    expect(priced.monthlyTotalCents).toBe(74_400);
  });
});

describe('reading the page’s money format back', () => {
  it('parses the page’s own figures', () => {
    expect(parseMoneyCents('R 5 000,00')).toBe(500000);
    expect(parseMoneyCents('R 693,00')).toBe(69300);
    expect(parseMoneyCents('R 1,00')).toBe(100);
    expect(parseMoneyCents('R 12 345')).toBe(1234500);
  });

  it('tolerates the other decimal convention', () => {
    expect(parseMoneyCents('1.234,56')).toBe(123456);
    expect(parseMoneyCents('693.00')).toBe(69300);
  });

  it('returns null for anything that is not a plain amount', () => {
    expect(parseMoneyCents('<script>alert(1)</script>')).toBeNull();
    expect(parseMoneyCents('')).toBeNull();
    expect(parseMoneyCents(undefined)).toBeNull();
    expect(parseMoneyCents('R 12,3456')).toBeNull();
  });
});

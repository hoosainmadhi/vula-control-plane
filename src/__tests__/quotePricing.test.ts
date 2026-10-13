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
  it("prices tills and add-ons from the list, in the vocabulary's order", () => {
    const priced = priceQuote(base, 15);
    expect(priced.lines).toEqual([
      {
        label: '6 tills',
        detail: '(2 tills per store × 3 stores)',
        cents: 59400,
        rateCents: 9900,
        quantity: 6,
      },
      { label: 'Head Office', detail: '', cents: 9900 },
      { label: 'Credit accounts', detail: '', cents: 4900 },
    ]);
    expect(priced.monthlyTotalCents).toBe(74200);
    expect(priced.setupCents).toBe(SETUP_FEE_CENTS.assisted);
  });

  it('breaks the VAT out of the inclusive figures without losing a cent', () => {
    const priced = priceQuote(base, 15);
    expect(priced.monthlyTotalCents - priced.monthlyVatCents).toBe(64522);
    expect(priced.monthlyVatCents).toBe(9678);
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

  it('falls back to the store count when the tills do not divide evenly', () => {
    const priced = priceQuote({ stores: 3, tills: 7, addons: [], setup: 'self' }, 15);
    expect(priced.lines[0]).toEqual({
      label: '7 tills',
      detail: '(across 3 stores)',
      cents: 69300,
      rateCents: 9900,
      quantity: 7,
    });
    expect(priced.setupCents).toBe(SETUP_FEE_CENTS.self);
  });

  it('leaves the split off a single-store quote — there is nothing to split', () => {
    const priced = priceQuote({ stores: 1, tills: 2, addons: [], setup: 'self' }, 15);
    expect(priced.lines[0]).toEqual({
      label: '2 tills',
      detail: '',
      cents: 19800,
      rateCents: 9900,
      quantity: 2,
    });
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

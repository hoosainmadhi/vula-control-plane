import { PERIOD_LABEL, perTerminalLabel, rand, toCents, toRands } from './money';

/**
 * Money is the one thing every screen shows and every invoice states, so the
 * formatter's edge cases are worth pinning: a missing amount reads as an em
 * dash (never as R0,00), and form input becomes integer cents without a float
 * ever reaching the wire.
 *
 * Assertions normalise whitespace and match digits rather than exact glyphs:
 * Intl's ZAR output varies with the ICU build, and the contract is "cents in,
 * ZAR string out", not a particular space character.
 */
const flat = (value: string): string => value.replace(/\s/g, ' ');

describe('rand', () => {
  it('renders a missing amount as an em dash, not as zero', () => {
    expect(rand(null)).toBe('—');
    expect(rand(undefined)).toBe('—');
    expect(rand(0)).not.toBe('—');
  });

  it('formats cents as ZAR with grouping and a decimal comma', () => {
    expect(flat(rand(123456))).toContain('R 1 234,56');
    expect(flat(rand(0))).toContain('R 0,00');
    expect(flat(rand(50000))).toContain('R 500,00');
  });
});

describe('toCents', () => {
  it('turns form input into integer cents', () => {
    expect(toCents('12.34')).toBe(1234);
    expect(toCents('19.99')).toBe(1999);
    expect(toCents('1234.56')).toBe(123456);
    expect(toCents('500')).toBe(50000);
  });

  it('treats an empty or unusable field as zero rather than NaN', () => {
    expect(toCents('')).toBe(0);
    expect(toCents('abc')).toBe(0);
    expect(toCents('   ')).toBe(0);
  });

  it('always returns a whole number of cents', () => {
    for (const input of ['0.07', '10.10', '0.01', '99.99', '3.33']) {
      const cents = toCents(input);
      expect(Number.isInteger(cents)).toBe(true);
    }
    // The classic float trap: 0.07 as a float is 0.07000000000000001.
    expect(toCents('0.07')).toBe(7);
  });
});

describe('toRands', () => {
  it('renders an editable amount with two decimals', () => {
    expect(toRands(123456)).toBe('1234.56');
    expect(toRands(null)).toBe('0.00');
  });
});

describe('price labels', () => {
  it('names the recurrence — a bare number is not a price', () => {
    expect(PERIOD_LABEL.monthly).toBe('per month');
    expect(PERIOD_LABEL.annual).toBe('per year');
    expect(PERIOD_LABEL['once-off']).toBe('once-off');
  });

  it('says the rate includes VAT, because every quoted price does', () => {
    // The office reads this label to make pricing decisions; a rate that reads
    // as ex-VAT invites a tax line nobody planned for (2026-09-16).
    const label = flat(perTerminalLabel(50000, 'monthly'));
    expect(label).toContain('R 500,00');
    expect(label).toContain('/ terminal / month');
    expect(label).toContain('incl. VAT');
  });
});

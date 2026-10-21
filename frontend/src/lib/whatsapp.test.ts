import { WHATSAPP_BUNDLES, whatsAppBundle, whatsAppMessagesForCents } from './whatsapp';

/**
 * The onboarding wizard's bundle picker and the licence's monthly allowance read
 * the same table. A price that maps to the wrong allowance would sell 1000
 * messages for R50, so the mapping is pinned.
 */
describe('WhatsApp bundles', () => {
  it('maps each published price to its message allowance', () => {
    expect(WHATSAPP_BUNDLES.map((b) => [b.cents, b.messages])).toEqual([
      [5000, 250],
      [10_000, 500],
      [15_000, 750],
      [20_000, 1000],
    ]);
    expect(whatsAppMessagesForCents(5000)).toBe(250);
    expect(whatsAppMessagesForCents(10_000)).toBe(500);
    expect(whatsAppMessagesForCents(15_000)).toBe(750);
    expect(whatsAppMessagesForCents(20_000)).toBe(1000);
    // No price (or a non-positive one) falls back to the entry bundle, never a
    // free larger allowance.
    expect(whatsAppMessagesForCents(0)).toBe(250);
    expect(whatsAppMessagesForCents(null)).toBe(250);
    // A price between tiers buys the lower allowance.
    expect(whatsAppMessagesForCents(12_000)).toBe(500);
    expect(whatsAppMessagesForCents(18_000)).toBe(750);
  });

  it('returns the bundle a selected message count names', () => {
    expect(whatsAppBundle(500)).toEqual({
      messages: 500,
      cents: 10_000,
      label: '500 messages',
    });
    expect(whatsAppBundle(999)).toEqual(WHATSAPP_BUNDLES[0]);
  });
});

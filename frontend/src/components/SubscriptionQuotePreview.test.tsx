import { render } from '@testing-library/react';
import SubscriptionQuotePreview from './SubscriptionQuotePreview';
import type { Plan } from '../types';

/**
 * The preview is the operator's only view of the recurring figure before a
 * client is created. It used to treat every per-store plan as "custom pricing",
 * so the onboarding wizard could not show the R199 + R49 arithmetic it was
 * about to record. These assertions pin the same formula the server bills.
 */
const perStorePlan: Plan = {
  id: 1,
  code: 'vula-network',
  name: 'Vula Network',
  maxStores: 5,
  maxTerminalsPerStore: 3,
  features: ['advanced_reports'],
  featurePrices: {
    multi_store: 19_900,
    customer_credit: 4900,
    ecommerce_bridges: 4900,
  },
  pricingMode: 'per_store',
  terminalPriceCents: 4900,
  storePriceCents: 19_900,
  customAmountCents: 0,
  setupFeeCents: 150_000,
  billingPeriod: 'monthly',
  isActive: true,
  createdAt: '2026-10-20 00:00:00',
};

const addonOptions = [
  { key: 'multi_store', label: 'Head Office', cents: 19_900 },
  { key: 'customer_credit', label: 'Credit accounts', cents: 4900 },
  { key: 'ecommerce_bridges', label: 'E-commerce', cents: 4900 },
];

const text = (container: HTMLElement): string => (container.textContent ?? '').replace(/\s/g, ' ');

describe('SubscriptionQuotePreview', () => {
  it('prices a per-store estate at R199 a store plus R49 an extra till', () => {
    const { container } = render(
      <SubscriptionQuotePreview
        plan={perStorePlan}
        licensed={6}
        stores={3}
        addonOptions={addonOptions}
        selected={['multi_store', 'customer_credit', 'ecommerce_bridges']}
      />,
    );
    const body = text(container);
    expect(body).toContain('Stores (3');
    expect(body).toContain('R 597,00');
    expect(body).toContain('Additional tills (3');
    expect(body).toContain('R 147,00');
    // Head Office and E-commerce are one charge for the business; credit is
    // three stores' worth.
    expect(body).toContain('Head Office');
    expect(body).toContain('Credit accounts');
    expect(body).toContain('(3 × R 49,00)');
    expect(body).toContain('E-commerce');
    expect(body).toContain('R 1 139,00');
    expect(body).not.toContain('Custom pricing');
    expect(body).toContain('R 1 500,00');
  });

  it('includes the first till in a single store rather than charging it as extra', () => {
    const { container } = render(
      <SubscriptionQuotePreview
        plan={perStorePlan}
        licensed={2}
        stores={1}
        addonOptions={addonOptions}
        selected={[]}
      />,
    );
    const body = text(container);
    expect(body).toContain('Stores (1');
    expect(body).toContain('R 199,00');
    expect(body).toContain('Additional tills (1');
    expect(body).toContain('R 49,00');
    expect(body).toContain('R 248,00');
  });
});

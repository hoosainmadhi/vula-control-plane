import crypto from 'node:crypto';
import { issueLicence, verifyLicenceToken, generateLicenceKeyPair, licencePublicKey, resetLicenceKeys } from '../services/licenceSigner.js';

/**
 * The licence is the only thing standing between "a merchant's plan" and "a
 * merchant's opinion", so the crypto path gets tested directly: it must verify
 * what we signed, and must reject anything we did not.
 */
describe('licence signing', () => {
  const base = {
    sequence: 1,
    storeSlug: 'urban-threads-jhb',
    storeName: 'Urban Threads Jhb',
    companyId: 7,
    companyName: 'Urban Threads Retail Group',
    planCode: 'multi-store',
    planName: 'Multi-Store',
    features: ['multi_store', 'stock_transfers'],
    maxStores: 10,
    maxTerminalsPerStore: 25,
    paidThrough: '2026-10-31',
  };

  it('signs a licence that verifies, with a raw P-256 signature', () => {
    const signed = issueLicence(base);

    const [payload, sig] = signed.token.split('.');
    expect(payload).toBeTruthy();
    expect(sig).toBeTruthy();
    // IEEE-P1363 raw r||s for P-256 is exactly 64 bytes; WebCrypto expects this
    // form, so the length is part of the contract, not an implementation detail.
    expect(Buffer.from(sig!, 'base64url')).toHaveLength(64);

    const result = verifyLicenceToken(signed.token);
    expect(result.valid).toBe(true);
    expect(result.claims).toMatchObject({
      sequence: 1,
      storeSlug: 'urban-threads-jhb',
      planCode: 'multi-store',
      features: ['multi_store', 'stock_transfers'],
      maxStores: 10,
      maxTerminalsPerStore: 25,
      paidThrough: '2026-10-31',
    });
  });

  it('rejects a tampered payload', () => {
    const signed = issueLicence(base);
    const [payload, sig] = signed.token.split('.');
    const swapped = payload!.slice(0, -4) + 'AAAA';
    const result = verifyLicenceToken(`${swapped}.${sig}`);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/signature/i);
  });

  it('rejects a tampered signature', () => {
    const signed = issueLicence(base);
    const [payload, sig] = signed.token.split('.');
    const swapped = sig!.slice(0, -4) + 'AAAA';
    expect(verifyLicenceToken(`${payload}.${swapped}`).valid).toBe(false);
  });

  it('rejects malformed tokens rather than throwing', () => {
    for (const token of ['', 'nonsense', 'only-one-part.', '.onlysig', 'a.b.c']) {
      const result = verifyLicenceToken(token);
      expect(result.valid).toBe(false);
    }
  });

  it('rejects a licence signed by a different key', () => {
    const signed = issueLicence(base);
    const other = generateLicenceKeyPair();
    const otherKey = crypto.createPrivateKey({
      key: Buffer.from(other.privateKey, 'base64url'),
      format: 'der',
      type: 'pkcs8',
    });
    const [payload] = signed.token.split('.');
    const forged = crypto
      .sign('sha256', Buffer.from(payload!), { key: otherKey, dsaEncoding: 'ieee-p1363' })
      .toString('base64url');

    const result = verifyLicenceToken(`${payload}.${forged}`);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/signature/i);
  });

  it('clamps the offline window to paid-through plus grace once a subscription lapses', () => {
    const now = new Date('2026-09-10T10:00:00Z');

    // Paid up: the rolling offline window (14 days) applies.
    const paid = issueLicence({ ...base, paidThrough: '2026-10-31', now });
    expect(paid.claims.maxOfflineUntil).toBe('2026-09-24T10:00:00.000Z');

    // Lapsed: paid-through + 3 days grace wins, so offline trade stops even if
    // the register never reconnects.
    const lapsed = issueLicence({ ...base, paidThrough: '2026-09-01', now });
    expect(lapsed.claims.maxOfflineUntil).toBe('2026-09-04T23:59:59.000Z');
  });

  it('honours the configured offline and grace windows', () => {
    const now = new Date('2026-09-10T00:00:00Z');
    const offlineDays = Number(process.env.LICENCE_OFFLINE_DAYS || 14);
    const signed = issueLicence({ ...base, paidThrough: null, now });
    const expected = new Date(now.getTime() + offlineDays * 24 * 60 * 60 * 1000).toISOString();
    expect(signed.claims.maxOfflineUntil).toBe(expected);
  });

  it('carries a keyId so keys can be rotated', () => {
    const signed = issueLicence(base);
    expect(signed.claims.keyId).toBeTruthy();
    expect(licencePublicKey()).toBeTruthy();
  });

  it('produces distinct licence ids and accepts an increasing sequence', () => {
    const a = issueLicence({ ...base, sequence: 1 });
    const b = issueLicence({ ...base, sequence: 2 });
    expect(a.claims.licenceId).not.toBe(b.claims.licenceId);
    expect(b.claims.sequence).toBe(2);
  });

  it('resetLicenceKeys is available for tests that swap key material', () => {
    resetLicenceKeys();
    const signed = issueLicence(base);
    expect(verifyLicenceToken(signed.token).valid).toBe(true);
  });
});

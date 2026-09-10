/**
 * Generate the licence signing keypair.
 *
 * Run: npx tsx scripts/generate-licence-key.ts
 *
 * Put the private key in the control plane's env (LEASE_PRIVATE_KEY) and the
 * public key in every store's env (LEASE_PUBLIC_KEY). The private key must never
 * reach a store — that separation is the whole point of the asymmetric scheme.
 */
import { generateLicenceKeyPair } from '../src/services/licenceSigner.js';

const { privateKey, publicKey } = generateLicenceKeyPair();

console.log('# Control plane (keep secret — never put this in a store)');
console.log(`LEASE_PRIVATE_KEY=${privateKey}`);
console.log(`LEASE_KEY_ID=k1`);
console.log('');
console.log('# Stores (safe to distribute — verifies only)');
console.log(`LEASE_PUBLIC_KEY=${publicKey}`);
console.log(`LEASE_KEY_ID=k1`);

/**
 * WhatsApp messaging bundles, mirrored from the server's
 * `services/features.ts` (the two builds cannot share a module). The price is
 * per company per month and the messages are its monthly allowance.
 */
export const WHATSAPP_BUNDLES = [
  { messages: 250, cents: 5000, label: '250 messages' },
  { messages: 500, cents: 10_000, label: '500 messages' },
  { messages: 750, cents: 15_000, label: '750 messages' },
  { messages: 1000, cents: 20_000, label: '1000 messages' },
] as const;

export const whatsAppBundle = (messages: number) =>
  WHATSAPP_BUNDLES.find((b) => b.messages === messages) ?? WHATSAPP_BUNDLES[0];

/** The nearest bundle at or below an agreed price; 250 is the entry default. */
export const whatsAppMessagesForCents = (cents: number | null | undefined): number => {
  if (!cents || cents <= 0) return WHATSAPP_BUNDLES[0].messages;
  if (cents >= 20_000) return 1000;
  if (cents >= 15_000) return 750;
  if (cents >= 10_000) return 500;
  return 250;
};

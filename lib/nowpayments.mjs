import crypto from 'node:crypto';

export function isValidNowPaymentsSignature(payload, signature, secret) {
  if (!secret || !/^[a-f\d]{128}$/i.test(signature || '')) return false;
  const serializedPayload = JSON.stringify(payload, Object.keys(payload).sort());
  const expected = crypto.createHmac('sha512', secret).update(serializedPayload).digest();
  const received = Buffer.from(signature, 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { isValidNowPaymentsSignature } from '../lib/nowpayments.mjs';

const secret = 'test-ipn-secret';
const payload = { payment_status: 'finished', order_id: 'order-123', price_amount: 1.25 };
const signature = crypto.createHmac('sha512', secret)
  .update(JSON.stringify(payload, Object.keys(payload).sort()))
  .digest('hex');

test('accepts a valid NOWPayments IPN signature', () => {
  assert.equal(isValidNowPaymentsSignature(payload, signature, secret), true);
});

test('rejects invalid signatures and missing secrets', () => {
  assert.equal(isValidNowPaymentsSignature(payload, '0'.repeat(128), secret), false);
  assert.equal(isValidNowPaymentsSignature(payload, signature, ''), false);
});
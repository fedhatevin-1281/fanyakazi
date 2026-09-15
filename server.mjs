import 'dotenv/config';
import express from 'express';
import { createClient } from '@supabase/supabase-js';

const app = express();
const port = Number(process.env.PORT || 3000);
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

app.use(express.json());
app.use(express.static('.'));

async function authenticatedUser(req, res) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ error: 'Invalid session' });
    return null;
  }
  return data.user;
}

async function paystackRequest(path, body) {
  const response = await fetch(`https://api.paystack.co/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok || !payload.status) throw new Error(payload.message || 'Paystack request failed');
  return payload.data;
}

app.post('/api/paystack/initialize', async (req, res) => {
  try {
    const user = await authenticatedUser(req, res);
    if (!user) return;
    const { programSlug, amount } = req.body || {};
    if (!programSlug || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ error: 'A valid program and amount are required' });
    }
    const { data: program, error: programError } = await supabaseAdmin
      .from('programs').select('id, slug, name, unlock_amount').eq('slug', programSlug).eq('is_active', true).single();
    if (programError || !program || Number(program.unlock_amount) !== Number(amount)) {
      return res.status(400).json({ error: 'Invalid program amount' });
    }
    const reference = `vh_${user.id}_${Date.now()}`;
    const transaction = await paystackRequest('transaction/initialize', {
      email: user.email || `${user.id}@users.vistahub.co.ke`,
      amount: Math.round(Number(amount) * 100),
      currency: 'KES',
      reference,
      callback_url: `${process.env.APP_URL}/payment-callback.html`,
      metadata: { user_id: user.id, program_id: program.id, program_slug: program.slug }
    });
    const { error: insertError } = await supabaseAdmin.from('transactions').insert({
      user_id: user.id, program_id: program.id, type: 'program_unlock', amount: Number(amount),
      currency: 'KES', status: 'pending', paystack_reference: reference,
      paystack_access_code: transaction.access_code, customer_email: user.email
    });
    if (insertError) throw insertError;
    res.json({ authorization_url: transaction.authorization_url, access_code: transaction.access_code, reference });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to initialize payment' });
  }
});

app.get('/api/paystack/verify/:reference', async (req, res) => {
  try {
    const user = await authenticatedUser(req, res);
    if (!user) return;
    const { reference } = req.params;
    const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });
    const payload = await response.json();
    if (!response.ok || !payload.status || payload.data.status !== 'success') {
      return res.status(400).json({ error: 'Payment has not been confirmed' });
    }
    const payment = payload.data;
    const { data: transaction, error: transactionError } = await supabaseAdmin
      .from('transactions').select('id, user_id, program_id, amount, status').eq('paystack_reference', reference).single();
    if (transactionError || !transaction || transaction.user_id !== user.id ||
        Number(transaction.amount) * 100 !== Number(payment.amount)) {
      return res.status(403).json({ error: 'Payment does not match this account' });
    }
    const { error: updateError } = await supabaseAdmin.from('transactions').update({
      status: 'success', paystack_transaction_id: String(payment.id), paid_at: new Date().toISOString()
    }).eq('id', transaction.id).eq('status', 'pending');
    if (updateError) throw updateError;
    if (transaction.program_id) {
      await supabaseAdmin.from('user_programs').upsert({
        user_id: user.id, program_id: transaction.program_id, transaction_id: transaction.id
      }, { onConflict: 'user_id,program_id' });
    }
    res.json({ status: 'success', reference });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to verify payment' });
  }
});

app.listen(port, () => console.log(`VistaHub API listening on http://localhost:${port}`));
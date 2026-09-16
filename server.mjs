import 'dotenv/config';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'node:url';

const app = express();
const port = Number(process.env.PORT || 3000);
const requiredEnv = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'PAYSTACK_SECRET_KEY'];
const missingEnv = requiredEnv.filter((name) => !process.env[name]);
if (missingEnv.length) {
  console.error(`Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exitCode = 1;
}

const supabaseAdmin = missingEnv.includes('SUPABASE_URL') || missingEnv.includes('SUPABASE_SERVICE_ROLE_KEY')
  ? null
  : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

app.use(express.json());
app.use(express.static('.'));

app.get('/admin-dashboard', (req, res) => {
  res.sendFile(fileURLToPath(new URL('./admin/index.html', import.meta.url)));
});

async function authenticatedUser(req, res) {
  if (!supabaseAdmin) {
    res.status(503).json({ error: 'Authentication service is not configured' });
    return null;
  }
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

async function authenticatedAdmin(req, res) {
  const user = await authenticatedUser(req, res);
  if (!user) return null;
  const { data: profile, error } = await supabaseAdmin
    .from('profiles').select('role, is_active').eq('id', user.id).single();
  if (error || !profile || profile.role !== 'admin' || !profile.is_active) {
    res.status(403).json({ error: 'Administrator access required' });
    return null;
  }
  return user;
}

async function paystackRequest(path, body) {
  if (!process.env.PAYSTACK_SECRET_KEY) throw new Error('Payment service is not configured');
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
      email: user.email || `${user.id}@users.fanyakazi.co.ke`,
      amount: Math.round(Number(amount) * 100),
      currency: 'KES',
      reference,
      callback_url: `${process.env.APP_URL || `http://localhost:${port}`}/payment-callback.html`,
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

app.get('/api/admin/overview', async (req, res) => {
  try {
    const user = await authenticatedAdmin(req, res);
    if (!user) return;
    const [usersResult, referralsResult, transactionsResult, programsResult] = await Promise.all([
      supabaseAdmin.from('profiles').select('id, username, phone, country, role, is_active, created_at, referral_code').order('created_at', { ascending: false }).limit(100),
      supabaseAdmin.from('referrals').select('id, referrer_id, referred_id, created_at').order('created_at', { ascending: false }).limit(100),
      supabaseAdmin.from('transactions').select('id, user_id, program_id, amount, currency, status, type, paystack_reference, created_at, paid_at').order('created_at', { ascending: false }).limit(100),
      supabaseAdmin.from('programs').select('id, name, slug, unlock_amount, is_active').order('name')
    ]);
    const failure = [usersResult, referralsResult, transactionsResult, programsResult].find((result) => result.error);
    if (failure) throw failure.error;
    const transactions = transactionsResult.data || [];
    const successful = transactions.filter((transaction) => transaction.status === 'success');
    const revenue = successful.reduce((total, transaction) => total + Number(transaction.amount || 0), 0);
    res.json({
      users: usersResult.data || [],
      referrals: referralsResult.data || [],
      transactions,
      programs: programsResult.data || [],
      metrics: {
        users: usersResult.data?.length || 0,
        referrals: referralsResult.data?.length || 0,
        successfulPayments: successful.length,
        revenue
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to load admin activity' });
  }
});

if (process.env.VERCEL !== '1') {
  app.listen(port, () => console.log(`Fanyakazi API listening on http://localhost:${port}`));
}

export default app;
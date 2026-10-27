import 'dotenv/config';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';

const app = express();
const port = Number(process.env.PORT || 3000);
const requiredEnv = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NOWPAYMENTS_API_KEY', 'NOWPAYMENTS_IPN_SECRET'];
const missingEnv = requiredEnv.filter((name) => !process.env[name]);
if (missingEnv.length) {
  console.error(`Missing required environment variables: ${missingEnv.join(', ')}`);
}

const supabaseAdmin = missingEnv.includes('SUPABASE_URL') || missingEnv.includes('SUPABASE_SERVICE_ROLE_KEY')
  ? null
  : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

app.use(express.json());

const serveAdminLogin = (req, res) => {
  const loginPath = fileURLToPath(new URL('./admin/login.html', import.meta.url));
  res.type('html').send(readFileSync(loginPath, 'utf8'));
};
app.get(['/admin', '/admin/'], serveAdminLogin);
app.get('/admin/login.html', serveAdminLogin);
app.get('/admin/login.php.html', serveAdminLogin);

app.get('/admin-dashboard', (req, res) => {
  const dashboardPath = fileURLToPath(new URL('./admin/index.html', import.meta.url));
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.type('html').send(readFileSync(dashboardPath, 'utf8'));
});

app.use(express.static('.'));

const serveWorkHub = (req, res) => {
  const workPath = fileURLToPath(new URL('./work/index.html', import.meta.url));
  res.type('html').send(readFileSync(workPath, 'utf8'));
};
app.get('/work', serveWorkHub);
app.get('/work/', serveWorkHub);

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

async function ensureWallet(userId) {
  const { data: wallet, error: walletError } = await supabaseAdmin
    .from('wallets').select('id, balance, lifetime_earned').eq('user_id', userId).maybeSingle();
  if (walletError && walletError.code !== 'PGRST116') throw walletError;
  if (wallet) return wallet;
  const { data: created, error: createError } = await supabaseAdmin
    .from('wallets').insert({ user_id: userId, balance: 0, lifetime_earned: 0 }).select('id, balance, lifetime_earned').single();
  if (createError) throw createError;
  return created;
}

function isFridayWithdrawalDay() {
  return new Date().getDay() === 5;
}

async function awardTaskReward(userId, programId, jobId, amount, description) {
  const wallet = await ensureWallet(userId);
  const nextBalance = Number(wallet.balance || 0) + Number(amount);
  const nextLifetime = Number(wallet.lifetime_earned || 0) + Number(amount);
  const { error: updateError } = await supabaseAdmin.from('wallets').update({
    balance: nextBalance,
    lifetime_earned: nextLifetime
  }).eq('user_id', userId);
  if (updateError) throw updateError;
  const { error: ledgerError } = await supabaseAdmin.from('wallet_ledger').insert({
    user_id: userId,
    program_id: programId,
    type: 'earning',
    amount: Number(amount),
    description
  });
  if (ledgerError) throw ledgerError;
  return { balance: nextBalance, lifetime_earned: nextLifetime };
}

function normalizeImageUrls(value) {
  const raw = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(/\r?\n|,/) : []);
  return [...new Set(raw.map((item) => String(item || '').trim()).filter(Boolean))];
}

async function nowPaymentsRequest(path, body) {
  if (!process.env.NOWPAYMENTS_API_KEY) throw new Error('Payment service is not configured');
  const response = await fetch(`https://api.nowpayments.io/v1/${path}`, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.NOWPAYMENTS_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || 'NOWPayments request failed');
  return payload;
}

function isValidNowPaymentsSignature(payload, signature) {
  if (!process.env.NOWPAYMENTS_IPN_SECRET || !/^[a-f\d]{128}$/i.test(signature || '')) return false;
  const orderedPayload = Object.keys(payload).sort().reduce((ordered, key) => {
    ordered[key] = payload[key];
    return ordered;
  }, {});
  const expected = crypto.createHmac('sha512', process.env.NOWPAYMENTS_IPN_SECRET)
    .update(JSON.stringify(orderedPayload)).digest();
  const received = Buffer.from(signature, 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

app.post('/api/nowpayments/ipn', async (req, res) => {
  try {
    if (!isValidNowPaymentsSignature(req.body || {}, req.headers['x-nowpayments-sig'])) {
      return res.status(401).json({ error: 'Invalid payment notification signature' });
    }
    const payment = req.body;
    const reference = payment.order_id;
    if (!reference) return res.status(400).json({ error: 'Payment order reference is required' });
    const { data: transaction, error: transactionError } = await supabaseAdmin
      .from('transactions').select('id, user_id, program_id, status, provider_price_amount, provider_price_currency')
      .eq('payment_provider', 'nowpayments').eq('provider_reference', reference).single();
    if (transactionError || !transaction) return res.status(404).json({ error: 'Payment order not found' });
    if (Number(transaction.provider_price_amount) !== Number(payment.price_amount) ||
        String(transaction.provider_price_currency).toLowerCase() !== String(payment.price_currency).toLowerCase()) {
      return res.status(400).json({ error: 'Payment amount does not match the order' });
    }

    if (payment.payment_status === 'finished') {
      if (!['pending', 'success'].includes(transaction.status)) {
        return res.status(409).json({ error: 'Payment order is no longer pending' });
      }
      const { error: updateError } = await supabaseAdmin.from('transactions').update({
        status: 'success', nowpayments_payment_id: String(payment.payment_id || ''), paid_at: new Date().toISOString()
      }).eq('id', transaction.id).eq('status', 'pending');
      if (updateError) throw updateError;
      if (transaction.program_id) {
        const { error: accessError } = await supabaseAdmin.from('user_programs').upsert({
          user_id: transaction.user_id, program_id: transaction.program_id, transaction_id: transaction.id
        }, { onConflict: 'user_id,program_id' });
        if (accessError) throw accessError;
      }
    } else if (['failed', 'refunded', 'expired'].includes(payment.payment_status) && transaction.status === 'pending') {
      const status = payment.payment_status === 'expired' ? 'abandoned' : 'failed';
      const { error: updateError } = await supabaseAdmin.from('transactions').update({ status })
        .eq('id', transaction.id).eq('status', 'pending');
      if (updateError) throw updateError;
    }
    res.json({ received: true });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to process payment notification' });
  }
});

app.post('/api/nowpayments/initialize', async (req, res) => {
  let transactionId;
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
    const conversionRate = Number(process.env.NOWPAYMENTS_KES_TO_PRICE_CURRENCY_RATE);
    if (!Number.isFinite(conversionRate) || conversionRate <= 0) {
      return res.status(503).json({ error: 'Payment currency conversion is not configured' });
    }
    const priceCurrency = (process.env.NOWPAYMENTS_PRICE_CURRENCY || 'usd').toLowerCase();
    const providerPriceAmount = Number((Number(amount) * conversionRate).toFixed(2));
    if (providerPriceAmount <= 0) return res.status(400).json({ error: 'Invalid converted payment amount' });
    const reference = `vh_${crypto.randomUUID()}`;
    const { data: transaction, error: insertError } = await supabaseAdmin.from('transactions').insert({
      user_id: user.id, program_id: program.id, type: 'program_unlock', amount: Number(amount),
      currency: 'KES', status: 'pending', payment_provider: 'nowpayments', provider_reference: reference,
      provider_price_amount: providerPriceAmount, provider_price_currency: priceCurrency, customer_email: user.email
    }).select('id').single();
    if (insertError) throw insertError;
    transactionId = transaction.id;

    const baseUrl = process.env.APP_URL || `http://localhost:${port}`;
    const invoice = await nowPaymentsRequest('invoice', {
      price_amount: providerPriceAmount,
      price_currency: priceCurrency,
      order_id: reference,
      order_description: `${program.name} program unlock`,
      ipn_callback_url: `${baseUrl}/api/nowpayments/ipn`,
      success_url: `${baseUrl}/payment-callback.html?order_id=${encodeURIComponent(reference)}`,
      cancel_url: `${baseUrl}/user/activate.html?payment=cancelled`
    });
    const { error: updateError } = await supabaseAdmin.from('transactions').update({
      nowpayments_invoice_id: String(invoice.id)
    }).eq('id', transaction.id);
    if (updateError) throw updateError;
    res.json({ invoice_url: invoice.invoice_url, reference });
  } catch (error) {
    if (transactionId) {
      await supabaseAdmin.from('transactions').update({ status: 'failed' }).eq('id', transactionId).eq('status', 'pending');
    }
    res.status(500).json({ error: error.message || 'Unable to initialize payment' });
  }
});

app.get('/api/nowpayments/verify/:reference', async (req, res) => {
  try {
    const user = await authenticatedUser(req, res);
    if (!user) return;
    const { data: transaction, error } = await supabaseAdmin.from('transactions')
      .select('status').eq('payment_provider', 'nowpayments').eq('provider_reference', req.params.reference)
      .eq('user_id', user.id).single();
    if (error || !transaction) return res.status(404).json({ error: 'Payment order not found' });
    res.json({ status: transaction.status });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to verify payment' });
  }
});

app.get('/api/admin/overview', async (req, res) => {
  try {
    const user = await authenticatedAdmin(req, res);
    if (!user) return;
    const [usersResult, referralsResult, transactionsResult, programsResult, jobsResult, withdrawalsResult] = await Promise.all([
      supabaseAdmin.from('profiles').select('id, username, phone, country, role, is_active, created_at, referral_code').order('created_at', { ascending: false }).limit(100),
      supabaseAdmin.from('referrals').select('id, referrer_id, referred_id, created_at').order('created_at', { ascending: false }).limit(100),
      supabaseAdmin.from('transactions').select('id, user_id, program_id, amount, currency, status, type, payment_provider, provider_reference, created_at, paid_at').order('created_at', { ascending: false }).limit(100),
      supabaseAdmin.from('programs').select('id, name, slug, unlock_amount, is_active').order('name'),
      supabaseAdmin.from('jobs').select('id, program_id, category, title, description, image_url, image_urls, external_url, reward, created_at, created_by').order('created_at', { ascending: false }),
      supabaseAdmin.from('withdrawal_requests').select('id, user_id, amount, phone, note, status, requested_at, approved_at').order('requested_at', { ascending: false }).limit(100)
    ]);
    const failure = [usersResult, referralsResult, transactionsResult, programsResult, jobsResult, withdrawalsResult].find((result) => result.error);
    if (failure) throw failure.error;
    const transactions = transactionsResult.data || [];
    const successful = transactions.filter((transaction) => transaction.status === 'success');
    const paid = successful.filter((transaction) => transaction.type !== 'admin_grant');
    const revenue = paid.reduce((total, transaction) => total + Number(transaction.amount || 0), 0);
    res.json({
      users: usersResult.data || [],
      referrals: referralsResult.data || [],
      transactions,
      programs: programsResult.data || [],
      jobs: jobsResult.data || [],
      withdrawals: withdrawalsResult.data || [],
      metrics: {
        users: usersResult.data?.length || 0,
        referrals: referralsResult.data?.length || 0,
        successfulPayments: paid.length,
        revenue
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to load admin activity' });
  }
});

app.get('/api/admin/withdrawals', async (req, res) => {
  try {
    const admin = await authenticatedAdmin(req, res);
    if (!admin) return;
    const { data, error } = await supabaseAdmin
      .from('withdrawal_requests')
      .select('id, user_id, amount, phone, note, status, requested_at, approved_at, approved_by')
      .order('requested_at', { ascending: false });
    if (error) throw error;
    res.json({ withdrawals: data || [] });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to load withdrawal requests' });
  }
});

app.post('/api/admin/withdrawals/:id/approve', async (req, res) => {
  try {
    const admin = await authenticatedAdmin(req, res);
    if (!admin) return;
    const { id } = req.params;
    const { data: request, error: requestError } = await supabaseAdmin
      .from('withdrawal_requests').select('id, user_id, amount, phone, status').eq('id', id).single();
    if (requestError || !request) return res.status(404).json({ error: 'Withdrawal request not found' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'This request is no longer pending' });
    const wallet = await ensureWallet(request.user_id);
    const currentBalance = Number(wallet.balance || 0);
    const nextBalance = Math.max(0, currentBalance - Number(request.amount));
    const { error: walletError } = await supabaseAdmin.from('wallets').update({ balance: nextBalance }).eq('user_id', request.user_id);
    if (walletError) throw walletError;
    const { error: updateError } = await supabaseAdmin.from('withdrawal_requests').update({
      status: 'approved',
      approved_by: admin.id,
      approved_at: new Date().toISOString()
    }).eq('id', id).eq('status', 'pending');
    if (updateError) throw updateError;
    const { error: ledgerError } = await supabaseAdmin.from('wallet_ledger').insert({
      user_id: request.user_id,
      type: 'withdrawal',
      amount: Number(request.amount),
      description: `Approved withdrawal request ${request.id}`,
      source_user_id: admin.id
    });
    if (ledgerError) throw ledgerError;
    res.json({ status: 'approved', request: { id: request.id, amount: request.amount } });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to approve withdrawal' });
  }
});

app.post('/api/admin/withdrawals/:id/reject', async (req, res) => {
  try {
    const admin = await authenticatedAdmin(req, res);
    if (!admin) return;
    const { id } = req.params;
    const { note } = req.body || {};
    const { error } = await supabaseAdmin.from('withdrawal_requests').update({
      status: 'rejected',
      approved_by: admin.id,
      approved_at: new Date().toISOString(),
      note: note ? String(note).trim() || null : null
    }).eq('id', id).eq('status', 'pending');
    if (error) throw error;
    res.json({ status: 'rejected', id });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to reject withdrawal' });
  }
});

app.delete('/api/admin/jobs/:jobId', async (req, res) => {
  try {
    const admin = await authenticatedAdmin(req, res);
    if (!admin) return;
    const { jobId } = req.params;
    const { data: job, error: lookupError } = await supabaseAdmin
      .from('jobs').select('id, created_by').eq('id', jobId).maybeSingle();
    if (lookupError) throw lookupError;
    if (!job) return res.status(404).json({ error: 'Task not found' });
    if (job.created_by && job.created_by !== admin.id) {
      return res.status(403).json({ error: 'You can only delete tasks you created' });
    }
    const { error: deleteError } = await supabaseAdmin.from('jobs').delete().eq('id', jobId);
    if (deleteError) throw deleteError;
    res.json({ status: 'deleted', jobId });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to delete task' });
  }
});

app.post('/api/admin/grant-access', async (req, res) => {
  try {
    const admin = await authenticatedAdmin(req, res);
    if (!admin) return;
    const { userId, programSlug } = req.body || {};
    if (!userId || !programSlug) return res.status(400).json({ error: 'A user and program are required' });
    const { data: program, error: programError } = await supabaseAdmin
      .from('programs').select('id, slug, unlock_amount').eq('slug', programSlug).eq('is_active', true).single();
    if (programError || !program) return res.status(400).json({ error: 'Program not found' });
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles').select('id').eq('id', userId).single();
    if (profileError || !profile) return res.status(404).json({ error: 'User not found' });
    const { data: existing, error: existingError } = await supabaseAdmin
      .from('user_programs').select('id, is_active').eq('user_id', userId).eq('program_id', program.id).maybeSingle();
    if (existingError) throw existingError;
    if (existing && existing.is_active) return res.json({ status: 'already_active' });
    if (existing && !existing.is_active) {
      const { error: reactivateError } = await supabaseAdmin.from('user_programs').update({ is_active: true }).eq('id', existing.id);
      if (reactivateError) throw reactivateError;
      return res.json({ status: 'reactivated', programSlug });
    }
    const reference = `admin_grant_${userId}_${program.id}`;
    const { data: transaction, error: transactionError } = await supabaseAdmin.from('transactions').insert({
      user_id: userId, program_id: program.id, type: 'admin_grant', amount: Number(program.unlock_amount),
      currency: 'KES', status: 'success', payment_provider: 'manual', provider_reference: reference,
      customer_email: null, paid_at: new Date().toISOString(), metadata: { granted_by: admin.id }
    }).select('id').single();
    if (transactionError) throw transactionError;
    const { error: unlockError } = await supabaseAdmin.from('user_programs').insert({
      user_id: userId, program_id: program.id, transaction_id: transaction.id
    });
    if (unlockError) throw unlockError;
    res.json({ status: 'granted', programSlug });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to grant access' });
  }
});

app.get('/api/work/withdrawals', async (req, res) => {
  try {
    const user = await authenticatedUser(req, res);
    if (!user) return;
    const { data, error } = await supabaseAdmin
      .from('withdrawal_requests')
      .select('id, amount, phone, note, status, requested_at, approved_at, approved_by')
      .eq('user_id', user.id)
      .order('requested_at', { ascending: false });
    if (error) throw error;
    res.json({ withdrawals: data || [] });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to load withdrawal history' });
  }
});

app.post('/api/work/withdrawals/request', async (req, res) => {
  try {
    const user = await authenticatedUser(req, res);
    if (!user) return;
    const { amount, phone, note } = req.body || {};
    if (!isFridayWithdrawalDay()) {
      return res.status(400).json({ error: 'Payments are issued on Fridays.' });
    }
    const withdrawAmount = Number(amount);
    if (!Number.isFinite(withdrawAmount) || withdrawAmount <= 0) {
      return res.status(400).json({ error: 'Enter a valid withdrawal amount.' });
    }
    const cleanedPhone = String(phone || '').trim();
    if (!cleanedPhone) {
      return res.status(400).json({ error: 'A phone number is required for payout.' });
    }
    const wallet = await ensureWallet(user.id);
    if (withdrawAmount > Number(wallet.balance || 0)) {
      return res.status(400).json({ error: 'Withdrawal amount exceeds your available wallet balance.' });
    }
    const { data, error } = await supabaseAdmin.from('withdrawal_requests').insert({
      user_id: user.id,
      amount: withdrawAmount,
      phone: cleanedPhone,
      note: note ? String(note).trim() : null,
      status: 'pending'
    }).select('id, amount, status').single();
    if (error) throw error;
    res.json({ status: 'requested', request: data });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to request withdrawal' });
  }
});

app.get('/api/work/overview', async (req, res) => {
  try {
    const user = await authenticatedUser(req, res);
    if (!user) return;
    const { data: access, error: accessError } = await supabaseAdmin
      .from('user_programs').select('program_id, is_active').eq('user_id', user.id).eq('is_active', true);
    if (accessError) throw accessError;
    const programIds = (access || []).map((item) => item.program_id);
    const [programsResult, jobsResult, submissionsResult, walletResult, withdrawalsResult] = await Promise.all([
      programIds.length ? supabaseAdmin.from('programs').select('id, slug, name, description, task_reward').in('id', programIds) : Promise.resolve({ data: [], error: null }),
      programIds.length ? supabaseAdmin.from('jobs').select('id, program_id, category, title, description, image_url, external_url, reward, created_at').in('program_id', programIds).eq('is_active', true).order('created_at', { ascending: false }) : Promise.resolve({ data: [], error: null }),
      supabaseAdmin.from('job_submissions').select('job_id, status, reward, created_at, review_text').eq('user_id', user.id).order('created_at', { ascending: false }),
      supabaseAdmin.from('wallets').select('balance, lifetime_earned').eq('user_id', user.id).maybeSingle(),
      supabaseAdmin.from('withdrawal_requests').select('id, amount, phone, note, status, requested_at, approved_at').eq('user_id', user.id).order('requested_at', { ascending: false })
    ]);
    const failure = [programsResult, jobsResult, submissionsResult, walletResult, withdrawalsResult].find((result) => result.error);
    if (failure) throw failure.error;
    res.json({
      programs: programsResult.data || [],
      jobs: jobsResult.data || [],
      submissions: submissionsResult.data || [],
      wallet: walletResult.data || { balance: 0, lifetime_earned: 0 },
      withdrawals: withdrawalsResult.data || []
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to load work' });
  }
});

app.post('/api/work/reviews', async (req, res) => {
  try {
    const user = await authenticatedUser(req, res);
    if (!user) return;
    const { jobId, reviewText, proofUrl } = req.body || {};
    if (!jobId || !String(reviewText || '').trim()) return res.status(400).json({ error: 'A review is required' });
    const { data: job, error: jobError } = await supabaseAdmin.from('jobs').select('id, program_id, category, reward').eq('id', jobId).eq('category', 'hotel_review').eq('is_active', true).single();
    if (jobError || !job) return res.status(404).json({ error: 'Review job not found' });
    const { data: access, error: accessError } = await supabaseAdmin.from('user_programs').select('id').eq('user_id', user.id).eq('program_id', job.program_id).eq('is_active', true).maybeSingle();
    if (accessError) throw accessError;
    if (!access) return res.status(403).json({ error: 'Activate this program first' });
    const reward = 200;
    const { data: submission, error: submissionError } = await supabaseAdmin.from('job_submissions').insert({
      job_id: job.id,
      user_id: user.id,
      review_text: String(reviewText).trim(),
      proof_url: proofUrl || null,
      status: 'approved',
      reward
    }).select('id').single();
    if (submissionError) return res.status(submissionError.code === '23505' ? 409 : 500).json({ error: submissionError.code === '23505' ? 'You already completed this review' : submissionError.message });
    const wallet = await awardTaskReward(user.id, job.program_id, job.id, reward, `Completed hotel review: ${job.id}`);
    res.json({ status: 'approved', reward, submissionId: submission.id, wallet });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to submit review' });
  }
});

app.post('/api/work/ai-complete', async (req, res) => {
  try {
    const user = await authenticatedUser(req, res);
    if (!user) return;
    const { jobId, note, proofUrl } = req.body || {};
    if (!jobId || !String(note || '').trim()) return res.status(400).json({ error: 'Task notes are required' });
    const { data: job, error: jobError } = await supabaseAdmin.from('jobs').select('id, program_id, category, reward').eq('id', jobId).eq('category', 'ai_training').eq('is_active', true).single();
    if (jobError || !job) return res.status(404).json({ error: 'AI task not found' });
    const { data: access, error: accessError } = await supabaseAdmin.from('user_programs').select('id').eq('user_id', user.id).eq('program_id', job.program_id).eq('is_active', true).maybeSingle();
    if (accessError) throw accessError;
    if (!access) return res.status(403).json({ error: 'Activate this program first' });
    const reward = 500;
    const { data: submission, error: submissionError } = await supabaseAdmin.from('job_submissions').insert({
      job_id: job.id,
      user_id: user.id,
      review_text: String(note).trim(),
      proof_url: proofUrl || null,
      status: 'approved',
      reward
    }).select('id').single();
    if (submissionError) return res.status(submissionError.code === '23505' ? 409 : 500).json({ error: submissionError.code === '23505' ? 'You already completed this AI task' : submissionError.message });
    const wallet = await awardTaskReward(user.id, job.program_id, job.id, reward, `Completed AI task: ${job.id}`);
    res.json({ status: 'approved', reward, submissionId: submission.id, wallet });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to complete AI task' });
  }
});

app.post('/api/admin/jobs', async (req, res) => {
  try {
    const admin = await authenticatedAdmin(req, res);
    if (!admin) return;
    const { programSlug, category, title, description, imageUrl, imageUrls, externalUrl, reward } = req.body || {};
    if (!programSlug || !category || !title || !description) return res.status(400).json({ error: 'Program, category, title and description are required' });
    if ((category === 'hotel_review' && programSlug !== 'hotel-reviews') || (category === 'ai_training' && programSlug !== 'ai-training')) return res.status(400).json({ error: 'Category does not match the selected program' });
    const normalizedImages = normalizeImageUrls(imageUrls || imageUrl);
    if (category === 'hotel_review' && !normalizedImages.length) return res.status(400).json({ error: 'Hotel review jobs require at least one image URL' });
    if (category === 'ai_training' && !externalUrl) return res.status(400).json({ error: 'AI training jobs require a work link' });
    const { data: program, error: programError } = await supabaseAdmin.from('programs').select('id').eq('slug', programSlug).single();
    if (programError || !program) return res.status(404).json({ error: 'Program not found' });
    const defaultReward = category === 'hotel_review' ? 200 : 500;
    const insertPayload = {
      program_id: program.id,
      category,
      title: String(title).trim(),
      description: String(description).trim(),
      image_url: normalizedImages[0] || null,
      external_url: externalUrl || null,
      reward: Number(reward) || defaultReward,
      created_by: admin.id
    };
    if (normalizedImages.length > 1) insertPayload.image_urls = normalizedImages;
    const { data: job, error } = await supabaseAdmin.from('jobs').insert(insertPayload).select('id').single();
    if (error) throw error;
    res.json({ status: 'created', job, reward: Number(reward) || defaultReward, imageUrls: normalizedImages });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to create job' });
  }
});

if (process.env.VERCEL !== '1') {
  app.listen(port, () => console.log(`Fanyakazi API listening on http://localhost:${port}`));
}

export default app;
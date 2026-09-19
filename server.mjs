import 'dotenv/config';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const app = express();
const port = Number(process.env.PORT || 3000);
const requiredEnv = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'PAYSTACK_SECRET_KEY'];
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
    const callbackUrl = `${process.env.APP_URL || `${req.protocol}://${req.get('host')}`}/payment-callback.html`;
    const transaction = await paystackRequest('transaction/initialize', {
      email: user.email || `${user.id}@users.fanyakazi.co.ke`,
      amount: Math.round(Number(amount) * 100),
      currency: 'KES',
      reference,
      callback_url: callbackUrl,
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
      .from('transactions').select('id, user_id, program_id, amount, currency, status').eq('paystack_reference', reference).single();
    if (transactionError || !transaction || transaction.user_id !== user.id ||
        transaction.currency !== 'KES' || payment.currency !== 'KES' ||
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
    const paid = successful.filter((transaction) => transaction.type !== 'admin_grant');
    const revenue = paid.reduce((total, transaction) => total + Number(transaction.amount || 0), 0);
    res.json({
      users: usersResult.data || [],
      referrals: referralsResult.data || [],
      transactions,
      programs: programsResult.data || [],
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
      .from('user_programs').select('id').eq('user_id', userId).eq('program_id', program.id).maybeSingle();
    if (existingError) throw existingError;
    if (existing) return res.json({ status: 'already_active' });
    const reference = `admin_grant_${userId}_${program.id}`;
    const { data: transaction, error: transactionError } = await supabaseAdmin.from('transactions').insert({
      user_id: userId, program_id: program.id, type: 'program_unlock', amount: Number(program.unlock_amount),
      currency: 'KES', status: 'success', paystack_reference: reference,
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

app.get('/api/work/overview', async (req, res) => {
  try {
    const user = await authenticatedUser(req, res);
    if (!user) return;
    const { data: access, error: accessError } = await supabaseAdmin
      .from('user_programs').select('program_id, is_active').eq('user_id', user.id).eq('is_active', true);
    if (accessError) throw accessError;
    const programIds = (access || []).map((item) => item.program_id);
    if (!programIds.length) return res.json({ programs: [], jobs: [], submissions: [], wallet: { balance: 0, lifetime_earned: 0 } });
    const [programsResult, jobsResult, submissionsResult, walletResult] = await Promise.all([
      supabaseAdmin.from('programs').select('id, slug, name, description, task_reward').in('id', programIds),
      supabaseAdmin.from('jobs').select('id, program_id, category, title, description, image_url, external_url, reward, created_at').in('program_id', programIds).eq('is_active', true).order('created_at', { ascending: false }),
      supabaseAdmin.from('job_submissions').select('job_id, status, reward, created_at, review_text').eq('user_id', user.id).order('created_at', { ascending: false }),
      supabaseAdmin.from('wallets').select('balance, lifetime_earned').eq('user_id', user.id).maybeSingle()
    ]);
    const failure = [programsResult, jobsResult, submissionsResult, walletResult].find((result) => result.error);
    if (failure) throw failure.error;
    res.json({ programs: programsResult.data || [], jobs: jobsResult.data || [], submissions: submissionsResult.data || [], wallet: walletResult.data || { balance: 0, lifetime_earned: 0 } });
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
    const { programSlug, category, title, description, imageUrl, externalUrl, reward } = req.body || {};
    if (!programSlug || !category || !title || !description) return res.status(400).json({ error: 'Program, category, title and description are required' });
    if ((category === 'hotel_review' && programSlug !== 'hotel-reviews') || (category === 'ai_training' && programSlug !== 'ai-training')) return res.status(400).json({ error: 'Category does not match the selected program' });
    if (category === 'hotel_review' && !imageUrl) return res.status(400).json({ error: 'Hotel review jobs require an image URL' });
    if (category === 'ai_training' && !externalUrl) return res.status(400).json({ error: 'AI training jobs require a work link' });
    const { data: program, error: programError } = await supabaseAdmin.from('programs').select('id').eq('slug', programSlug).single();
    if (programError || !program) return res.status(404).json({ error: 'Program not found' });
    const defaultReward = category === 'hotel_review' ? 200 : 500;
    const { data: job, error } = await supabaseAdmin.from('jobs').insert({
      program_id: program.id,
      category,
      title: String(title).trim(),
      description: String(description).trim(),
      image_url: imageUrl || null,
      external_url: externalUrl || null,
      reward: Number(reward) || defaultReward
    }).select('id').single();
    if (error) throw error;
    res.json({ status: 'created', job, reward: Number(reward) || defaultReward });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to create job' });
  }
});

if (process.env.VERCEL !== '1') {
  app.listen(port, () => console.log(`Fanyakazi API listening on http://localhost:${port}`));
}

export default app;
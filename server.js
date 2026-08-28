// RankHighPro Backend
// Handles: Stripe subscription checkout, payment webhooks, live PageSpeed
// audits, DataForSEO rank/GBP checks, magic-link customer accounts, an
// automated weekly job that re-checks every active customer's listing, and
// an automated review-request email system.
//
// To run locally:
//   1. npm install
//   2. cp .env.example .env   (then fill in your real keys)
//   3. npm start
//
// Deploy this whole folder to Railway, Render, or similar.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const Stripe = require('stripe');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const cron = require('node-cron');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me';

// ---------------------------------------------------------------------------
// DATABASE
// Railway's Postgres add-on automatically injects DATABASE_URL once you
// attach a Postgres database to this service — no manual connection string
// needed. Railway's internal Postgres doesn't require SSL, so we only force
// SSL when talking to an external host (handles local dev + most hosts).
// ---------------------------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      plan TEXT,
      status TEXT NOT NULL DEFAULT 'inactive',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS magic_tokens (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracked_listings (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      business_name TEXT NOT NULL,
      website_url TEXT,
      location TEXT NOT NULL,
      keyword TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Adds the review_link column to tracked_listings if this table already
  // existed before this feature was added (safe to run every time).
  await pool.query(`
    ALTER TABLE tracked_listings ADD COLUMN IF NOT EXISTS review_link TEXT;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rank_history (
      id SERIAL PRIMARY KEY,
      tracked_listing_id INTEGER NOT NULL REFERENCES tracked_listings(id) ON DELETE CASCADE,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      local_pack_position INTEGER,
      review_count INTEGER,
      rating NUMERIC,
      raw JSONB
    );
  `);
  // ---------------------------------------------------------------------
  // REVIEW REQUESTS
  // One row per customer's-customer we're asking for a review. Tracks
  // which follow-up emails have gone out so the daily job below knows
  // exactly who needs what next.
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS review_requests (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      tracked_listing_id INTEGER REFERENCES tracked_listings(id) ON DELETE SET NULL,
      reviewer_name TEXT NOT NULL,
      reviewer_email TEXT NOT NULL,
      service_detail TEXT,
      first_email_sent_at TIMESTAMPTZ,
      second_email_sent_at TIMESTAMPTZ,
      reviewed BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // ---------------------------------------------------------------------
  // AI VISIBILITY CHECKS
  // One row per check run per listing. Records whether the business got
  // mentioned when we asked each AI platform a realistic buyer-style
  // question (e.g. "best kratom shop in Tucson"). NULL for a platform
  // means we didn't have an API key configured to check it that run.
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_checks (
      id SERIAL PRIMARY KEY,
      tracked_listing_id INTEGER NOT NULL REFERENCES tracked_listings(id) ON DELETE CASCADE,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      prompt_used TEXT NOT NULL,
      chatgpt_mentioned BOOLEAN,
      perplexity_mentioned BOOLEAN,
      gemini_mentioned BOOLEAN,
      grok_mentioned BOOLEAN,
      claude_mentioned BOOLEAN,
      raw JSONB
    );
  `);
  // ---------------------------------------------------------------------
  // GBP POSTS
  // AI-drafted Google Business Profile posts. Starts as 'pending' for the
  // customer to approve/reject. Once approved, status becomes 'approved'
  // and the customer gets copy/paste instructions. If/when Google Business
  // Profile API access is set up, an automated publish step can flip
  // approved posts to 'published' instead of leaving them manual.
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gbp_posts (
      id SERIAL PRIMARY KEY,
      tracked_listing_id INTEGER NOT NULL REFERENCES tracked_listings(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      decided_at TIMESTAMPTZ
    );
  `);
  // Adds the image_base64 column if this table already existed before image
  // generation was added (safe to run every time).
  await pool.query(`
    ALTER TABLE gbp_posts ADD COLUMN IF NOT EXISTS image_base64 TEXT;
  `);
  console.log('Database tables ready.');
}

// ---------------------------------------------------------------------------
// EMAIL (magic links + review requests)
// Uses Resend (resend.com) — sign up, verify a sending domain (or use their
// test domain while developing), grab an API key, set RESEND_API_KEY and
// RESEND_FROM_EMAIL in Railway's variables.
// ---------------------------------------------------------------------------
async function sendMagicLinkEmail(email, link) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — magic link not emailed. Link:', link);
    return;
  }
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL || 'RankHighPro <onboarding@resend.dev>',
      to: email,
      subject: 'Your RankHighPro login link',
      html: `<p>Click below to log in. This link expires in 15 minutes.</p><p><a href="${link}">${link}</a></p>`,
    }),
  });
}

// Sends either the first or second review-request email. `attempt` is 1 or 2.
async function sendReviewRequestEmail({ to, reviewerName, businessName, reviewLink, attempt }) {
  const subject = attempt === 1
    ? `How did we do, ${reviewerName}?`
    : `Quick favor, ${reviewerName}?`;

  const bodyIntro = attempt === 1
    ? `Thanks for choosing ${businessName}! We'd love to hear how everything went.`
    : `Just checking in — if you haven't had a chance yet, we'd really appreciate a quick review of your experience with ${businessName}.`;

  const html = `
    <p>Hi ${reviewerName},</p>
    <p>${bodyIntro}</p>
    <p>If you have a minute, a quick review helps us out a lot and helps other folks find us too.</p>
    <p><a href="${reviewLink}" style="display:inline-block;padding:12px 20px;background:#e15b4f;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold;">Leave a Review</a></p>
    <p>Thanks again,<br>${businessName}</p>
  `;

  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — review request not emailed. Would have sent to:', to);
    return;
  }

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL || 'RankHighPro <onboarding@resend.dev>',
      to,
      subject,
      html,
    }),
  });
}

// Stripe webhooks need the RAW request body, so this route is registered
// BEFORE express.json() runs on everything else.
app.post(
  '/webhook/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Webhook signature check failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          const email = session.customer_email || session.customer_details?.email;
          const plan = session.metadata?.plan || null;
          if (email) {
            await pool.query(
              `INSERT INTO customers (email, stripe_customer_id, stripe_subscription_id, plan, status)
               VALUES ($1, $2, $3, $4, 'active')
               ON CONFLICT (email) DO UPDATE SET
                 stripe_customer_id = EXCLUDED.stripe_customer_id,
                 stripe_subscription_id = EXCLUDED.stripe_subscription_id,
                 plan = EXCLUDED.plan,
                 status = 'active'`,
              [email, session.customer, session.subscription, plan]
            );
            console.log('Customer activated:', email, plan);
          }
          break;
        }
        case 'customer.subscription.deleted': {
          const sub = event.data.object;
          await pool.query(
            `UPDATE customers SET status = 'canceled' WHERE stripe_customer_id = $1`,
            [sub.customer]
          );
          console.log('Subscription canceled for Stripe customer:', sub.customer);
          break;
        }
        case 'invoice.payment_failed': {
          const invoice = event.data.object;
          await pool.query(
            `UPDATE customers SET status = 'past_due' WHERE stripe_customer_id = $1`,
            [invoice.customer]
          );
          console.log('Payment failed for Stripe customer:', invoice.customer);
          break;
        }
        default:
          console.log('Unhandled Stripe event:', event.type);
      }
    } catch (err) {
      console.error('Webhook DB update error:', err.message);
    }

    res.json({ received: true });
  }
);

// Everything else can safely parse JSON normally.
app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json());
app.use(express.static('public'));

// ---------------------------------------------------------------------------
// AUTH MIDDLEWARE — verifies the JWT sent as "Authorization: Bearer <token>"
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.customer = { id: payload.customerId, email: payload.email };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// ---------------------------------------------------------------------------
// POST /api/auth/request-link   Body: { email }
// Creates (or reuses) a customer record and emails a one-time login link.
// ---------------------------------------------------------------------------
app.post('/api/auth/request-link', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    // Make sure a customer row exists (status stays 'inactive' until they pay).
    await pool.query(
      `INSERT INTO customers (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
      [email]
    );

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    await pool.query(
      `INSERT INTO magic_tokens (email, token, expires_at) VALUES ($1, $2, $3)`,
      [email, token, expiresAt]
    );

    const link = `${BACKEND_URL}/api/auth/verify?token=${token}`;
    await sendMagicLinkEmail(email, link);

    res.json({ message: 'Check your email for a login link.' });
  } catch (err) {
    console.error('request-link error:', err.message);
    res.status(500).json({ error: 'Could not send login link' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/auth/verify?token=...
// Validates the one-time token, issues a JWT, redirects into the dashboard.
// ---------------------------------------------------------------------------
app.get('/api/auth/verify', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).send('Missing token');

    const result = await pool.query(
      `SELECT * FROM magic_tokens WHERE token = $1 AND used = false AND expires_at > now()`,
      [token]
    );
    if (result.rows.length === 0) {
      return res.status(400).send('This login link is invalid or has expired. Please request a new one.');
    }

    const magicToken = result.rows[0];
    await pool.query(`UPDATE magic_tokens SET used = true WHERE id = $1`, [magicToken.id]);

    const customerResult = await pool.query(
      `SELECT * FROM customers WHERE email = $1`,
      [magicToken.email]
    );
    const customer = customerResult.rows[0];

    const jwtToken = jwt.sign(
      { customerId: customer.id, email: customer.email },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.redirect(`${FRONTEND_URL}/dashboard.html#token=${jwtToken}`);
  } catch (err) {
    console.error('verify error:', err.message);
    res.status(500).send('Something went wrong logging you in.');
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard   (auth required)
// Returns the logged-in customer's subscription status, tracked listings,
// and the most recent rank-check result for each.
// ---------------------------------------------------------------------------
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const customerResult = await pool.query(
      `SELECT id, email, plan, status FROM customers WHERE id = $1`,
      [req.customer.id]
    );
    const customer = customerResult.rows[0];

    const listingsResult = await pool.query(
      `SELECT * FROM tracked_listings WHERE customer_id = $1 ORDER BY created_at ASC`,
      [req.customer.id]
    );

    const listings = [];
    for (const listing of listingsResult.rows) {
      const historyResult = await pool.query(
        `SELECT * FROM rank_history WHERE tracked_listing_id = $1 ORDER BY checked_at DESC LIMIT 8`,
        [listing.id]
      );
      listings.push({ ...listing, history: historyResult.rows });
    }

    res.json({ customer, listings });
  } catch (err) {
    console.error('dashboard error:', err.message);
    res.status(500).json({ error: 'Could not load dashboard' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/tracked-listings   (auth required)
// Body: { businessName, websiteUrl, location, keyword }
// ---------------------------------------------------------------------------
app.post('/api/tracked-listings', requireAuth, async (req, res) => {
  try {
    const { businessName, websiteUrl, location, keyword } = req.body;
    if (!businessName || !location || !keyword) {
      return res.status(400).json({ error: 'businessName, location, and keyword are required' });
    }

    const result = await pool.query(
      `INSERT INTO tracked_listings (customer_id, business_name, website_url, location, keyword)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.customer.id, businessName, websiteUrl || null, location, keyword]
    );

    res.json({ listing: result.rows[0] });
  } catch (err) {
    console.error('add tracked-listing error:', err.message);
    res.status(500).json({ error: 'Could not add tracked listing' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/tracked-listings/:id   (auth required, must own the listing)
// ---------------------------------------------------------------------------
app.delete('/api/tracked-listings/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM tracked_listings WHERE id = $1 AND customer_id = $2 RETURNING id`,
      [req.params.id, req.customer.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error('delete tracked-listing error:', err.message);
    res.status(500).json({ error: 'Could not delete listing' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/tracked-listings/:id/review-link   (auth required)
// Body: { reviewLink }
// Lets a customer set/update the direct Google review link for one of their
// tracked listings. Once this is set, review requests can be sent for it.
// ---------------------------------------------------------------------------
app.patch('/api/tracked-listings/:id/review-link', requireAuth, async (req, res) => {
  try {
    const { reviewLink } = req.body;
    if (!reviewLink || !reviewLink.startsWith('http')) {
      return res.status(400).json({ error: 'A valid reviewLink URL is required' });
    }

    const result = await pool.query(
      `UPDATE tracked_listings SET review_link = $1 WHERE id = $2 AND customer_id = $3 RETURNING *`,
      [reviewLink, req.params.id, req.customer.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    res.json({ listing: result.rows[0] });
  } catch (err) {
    console.error('set review-link error:', err.message);
    res.status(500).json({ error: 'Could not save review link' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/review-requests   (auth required)
// Body: { trackedListingId, reviewerName, reviewerEmail, serviceDetail }
// Creates a new review request. The daily job below sends the actual
// emails — this endpoint just records who to ask.
// ---------------------------------------------------------------------------
app.post('/api/review-requests', requireAuth, async (req, res) => {
  try {
    const { trackedListingId, reviewerName, reviewerEmail, serviceDetail } = req.body;
    if (!trackedListingId || !reviewerName || !reviewerEmail) {
      return res.status(400).json({ error: 'trackedListingId, reviewerName, and reviewerEmail are required' });
    }
    if (!reviewerEmail.includes('@')) {
      return res.status(400).json({ error: 'A valid reviewerEmail is required' });
    }

    // Confirm the listing belongs to this customer AND has a review link set.
    const listingResult = await pool.query(
      `SELECT * FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [trackedListingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    if (!listingResult.rows[0].review_link) {
      return res.status(400).json({
        error: 'This listing does not have a Google review link set yet. Add one first.',
      });
    }

    const result = await pool.query(
      `INSERT INTO review_requests (customer_id, tracked_listing_id, reviewer_name, reviewer_email, service_detail)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.customer.id, trackedListingId, reviewerName, reviewerEmail, serviceDetail || null]
    );

    res.json({ reviewRequest: result.rows[0] });
  } catch (err) {
    console.error('create review-request error:', err.message);
    res.status(500).json({ error: 'Could not create review request' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/review-requests   (auth required)
// Optional ?trackedListingId= to filter to one listing. Otherwise returns
// every review request for the logged-in customer, newest first.
// ---------------------------------------------------------------------------
app.get('/api/review-requests', requireAuth, async (req, res) => {
  try {
    const { trackedListingId } = req.query;
    let result;
    if (trackedListingId) {
      result = await pool.query(
        `SELECT * FROM review_requests WHERE customer_id = $1 AND tracked_listing_id = $2 ORDER BY created_at DESC`,
        [req.customer.id, trackedListingId]
      );
    } else {
      result = await pool.query(
        `SELECT * FROM review_requests WHERE customer_id = $1 ORDER BY created_at DESC`,
        [req.customer.id]
      );
    }
    res.json({ reviewRequests: result.rows });
  } catch (err) {
    console.error('list review-requests error:', err.message);
    res.status(500).json({ error: 'Could not load review requests' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/review-requests/:id/mark-reviewed   (auth required)
// Manually marks a review request as done (no automated Google review
// detection yet — the business owner checks and flags it themselves).
// ---------------------------------------------------------------------------
app.patch('/api/review-requests/:id/mark-reviewed', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE review_requests SET reviewed = true WHERE id = $1 AND customer_id = $2 RETURNING *`,
      [req.params.id, req.customer.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Review request not found' });
    }
    res.json({ reviewRequest: result.rows[0] });
  } catch (err) {
    console.error('mark-reviewed error:', err.message);
    res.status(500).json({ error: 'Could not update review request' });
  }
});

// ---------------------------------------------------------------------------
// PRICING TIERS
// ---------------------------------------------------------------------------
const PLANS = {
  watch: { name: 'RankHighPro Watch', amountCents: 4900 },
  grow: { name: 'RankHighPro Grow', amountCents: 14900 },
  managed: { name: 'RankHighPro Managed', amountCents: 39900 },
};

// ---------------------------------------------------------------------------
// POST /api/create-checkout-session
// Body: { plan: "watch" | "grow" | "managed", email }
// Email is now required so we can tie the Stripe subscription to a customer
// account (used by the webhook above to activate their dashboard access).
// ---------------------------------------------------------------------------
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { plan, email } = req.body;
    const selected = PLANS[plan];

    if (!selected) {
      return res.status(400).json({ error: 'Unknown plan: ' + plan });
    }
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid email is required to subscribe.' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      metadata: { plan },
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: selected.name },
            unit_amount: selected.amountCents,
            recurring: { interval: 'month' },
          },
          quantity: 1,
        },
      ],
      success_url: `${FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/cancel.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout session error:', err.message);
    res.status(500).json({ error: 'Could not start checkout' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/audit?url=https://example.com
// ---------------------------------------------------------------------------
app.get('/api/audit', async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) {
      return res.status(400).json({ error: 'Missing ?url=' });
    }

    const apiKey = process.env.PAGESPEED_API_KEY;
    const endpoint =
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` +
      `?url=${encodeURIComponent(targetUrl)}&key=${apiKey}&strategy=mobile`;

    const response = await fetch(endpoint);
    const data = await response.json();

    if (data.error) {
      return res.status(502).json({ error: data.error.message });
    }

    const perfScore = Math.round(
      (data.lighthouseResult?.categories?.performance?.score || 0) * 100
    );
    const audits = data.lighthouseResult?.audits || {};

    const findings = [];
    if (audits['is-crawlable'] && audits['is-crawlable'].score !== 1) {
      findings.push({ severity: 'error', message: "Googlebot may not be able to crawl this page properly." });
    }
    if (audits['largest-contentful-paint']) {
      const lcp = audits['largest-contentful-paint'].numericValue / 1000;
      if (lcp > 4) {
        findings.push({ severity: 'warn', message: `Largest Contentful Paint is ${lcp.toFixed(1)}s — aim for under 2.5s.` });
      }
    }
    if (audits['structured-data'] && audits['structured-data'].score !== 1) {
      findings.push({ severity: 'warn', message: 'Structured data (schema markup) may be missing or invalid.' });
    }

    res.json({ url: targetUrl, score: perfScore, findings });
  } catch (err) {
    console.error('PageSpeed audit error:', err.message);
    res.status(500).json({ error: 'Audit failed' });
  }
});

// ---------------------------------------------------------------------------
// Shared helper: runs a DataForSEO local-pack rank check for a keyword +
// location, and returns the raw items plus this business's local-pack
// position (or null if not found). Used by both the manual endpoint and the
// automated weekly job.
// ---------------------------------------------------------------------------
async function runRankCheck(keyword, location, businessName) {
  const auth = Buffer.from(
    `${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`
  ).toString('base64');

  const response = await fetch(
    'https://api.dataforseo.com/v3/serp/google/organic/live/advanced',
    {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ keyword, location_name: location, language_code: 'en', device: 'mobile' }]),
    }
  );

  const data = await response.json();
  const items = data?.tasks?.[0]?.result?.[0]?.items || [];
  const localPack = items.find((i) => i.type === 'local_pack');
  const localPackItems = localPack ? localPack.items : [];

  let position = null;
  if (businessName) {
    const idx = localPackItems.findIndex((i) =>
      (i.title || '').toLowerCase().includes(businessName.toLowerCase())
    );
    if (idx !== -1) position = idx + 1;
  }

  return { localPackItems, position, raw: data };
}

// ---------------------------------------------------------------------------
// GET /api/rank-check?keyword=...&location=...
// Manual/on-demand version (used by the free tool on the site).
// ---------------------------------------------------------------------------
app.get('/api/rank-check', async (req, res) => {
  try {
    const { keyword, location, business } = req.query;
    if (!keyword || !location) {
      return res.status(400).json({ error: 'Missing ?keyword= or ?location=' });
    }
    const { localPackItems, position } = await runRankCheck(keyword, location, business);
    res.json({ keyword, location, localPackResults: localPackItems, position });
  } catch (err) {
    console.error('Rank check error:', err.message);
    res.status(500).json({ error: 'Rank check failed' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ---------------------------------------------------------------------------
// Shared helper: runs a DataForSEO GBP lookup and returns the parsed result
// plus the free/premium findings split. Used by both the manual endpoint
// and the automated weekly job.
// ---------------------------------------------------------------------------
async function runGbpAudit(business, location) {
  let fullLocation = location.trim().replace(/\s*,\s*/g, ',');
  const commaCount = (fullLocation.match(/,/g) || []).length;
  if (commaCount === 1) fullLocation = fullLocation + ',United States';

  const auth = Buffer.from(
    `${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`
  ).toString('base64');

  const response = await fetch(
    'https://api.dataforseo.com/v3/business_data/google/my_business_info/live',
    {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ keyword: business, location_name: fullLocation, language_code: 'en' }]),
    }
  );

  const data = await response.json();
  const taskStatus = data?.tasks?.[0]?.status_message || data?.status_message || 'Unknown';
  const resultBlock = data?.tasks?.[0]?.result?.[0];
  const items = resultBlock?.items || [];
  const result = items.find((i) => i.type === 'google_business_info') || items[0];

  if (!result) return { found: false, taskStatus, fullLocation };

  const rating = result.rating?.value ?? null;
  const reviewCount = result.rating?.votes_count || 0;
  const isVerified = result.is_claimed ?? null;
  const categories = result.category ? [result.category] : (result.additional_categories || []);
  const hasPhotos = (result.total_photos || 0) > 0;
  const description = result.description || null;
  const phone = result.phone || null;
  const website = result.url || result.domain || null;
  const workHours = result.work_time || result.work_hours || result.hours || null;
  const hasWorkHours = !!(workHours && (Array.isArray(workHours) ? workHours.length : Object.keys(workHours).length));

  const findings = [];
  if (reviewCount < 30) {
    findings.push({ severity: 'error', message: `Only ${reviewCount} reviews found. Businesses ranking in the map pack for competitive terms often have 100+.` });
  } else if (reviewCount < 100) {
    findings.push({ severity: 'warn', message: `${reviewCount} reviews found — solid, but top-ranking competitors likely have more.` });
  }
  if (rating !== null && rating < 4.3) {
    findings.push({ severity: 'warn', message: `Average rating is ${rating} — ratings below 4.3 can quietly hurt click-through in the map pack.` });
  }

  const premiumFindings = [];
  if (isVerified === false) premiumFindings.push({ severity: 'error', message: 'This listing does not appear to be verified/claimed. Unclaimed listings rank significantly worse.' });
  if (!hasPhotos) premiumFindings.push({ severity: 'warn', message: 'No photos found on this listing. Listings with regular photo activity tend to rank and convert better.' });
  if (categories.length === 0) premiumFindings.push({ severity: 'error', message: 'No business category found.' });
  else if (categories.length === 1) premiumFindings.push({ severity: 'warn', message: 'Only one business category listed.' });
  if (!hasWorkHours) premiumFindings.push({ severity: 'warn', message: 'No business hours listed.' });
  if (!phone) premiumFindings.push({ severity: 'error', message: 'No phone number found on this listing.' });
  if (!website) premiumFindings.push({ severity: 'warn', message: 'No website link found on this listing.' });
  if (!description || description.trim().length < 50) premiumFindings.push({ severity: 'warn', message: 'Business description is missing or very short.' });

  return { found: true, fullLocation, rating, reviewCount, findings, premiumFindings };
}

// ---------------------------------------------------------------------------
// SCHEMA MARKUP CHECK
// Fetches a business's live website HTML and looks for LocalBusiness (or a
// subtype) JSON-LD structured data. If it's missing, we generate a ready
// -to-paste snippet filled in with whatever info we already have on file.
// ---------------------------------------------------------------------------
async function checkSchemaMarkup(websiteUrl) {
  try {
    // Add https:// automatically if someone saved a URL without a protocol
    // (e.g. "example.com" instead of "https://example.com").
    let normalizedUrl = websiteUrl.trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      normalizedUrl = `https://${normalizedUrl}`;
    }

    const response = await fetch(normalizedUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RankHighProBot/1.0)' },
    });
    const html = await response.text();

    const scriptMatches = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    let hasLocalBusinessSchema = false;
    const foundTypes = [];

    for (const match of scriptMatches) {
      try {
        const parsed = JSON.parse(match[1]);
        const blocks = Array.isArray(parsed) ? parsed : [parsed];
        for (const block of blocks) {
          const type = block['@type'];
          const typeStr = Array.isArray(type) ? type.join(', ') : (type || '');
          if (typeStr) foundTypes.push(typeStr);
          if (typeStr.toLowerCase().includes('business') || typeStr.toLowerCase().includes('localbusiness')) {
            hasLocalBusinessSchema = true;
          }
        }
      } catch (parseErr) {
        // Not valid JSON in this script block — skip it, don't fail the whole check.
      }
    }

    return { found: true, hasLocalBusinessSchema, foundTypes };
  } catch (err) {
    console.error('Schema markup check failed:', err.message);
    return { found: false, error: err.message };
  }
}

// Builds a ready-to-paste LocalBusiness JSON-LD snippet from the info we
// already have on file for a tracked listing. City/state are pulled out of
// the "City,State" location string we store.
function generateSchemaSnippet(listing) {
  const locationParts = (listing.location || '').split(',').map((p) => p.trim());
  const city = locationParts[0] || '';
  const state = locationParts[1] || '';

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: listing.business_name,
    address: {
      '@type': 'PostalAddress',
      addressLocality: city,
      addressRegion: state,
      addressCountry: 'US',
    },
  };
  if (listing.website_url) schema.url = listing.website_url;

  const jsonString = JSON.stringify(schema, null, 2);
  return `<script type="application/ld+json">\n${jsonString}\n</script>`;
}

// ---------------------------------------------------------------------------
// AI VISIBILITY CHECKS
// Asks ChatGPT, Perplexity, Gemini, and Grok a realistic buyer-style
// question and checks whether the business name shows up anywhere in the
// response. Each function returns `null` (not `false`) when that
// platform's API key isn't configured, so we can tell "not mentioned"
// apart from "we didn't check."
// ---------------------------------------------------------------------------
function textMentionsBusiness(text, businessName) {
  if (!text || !businessName) return false;
  return text.toLowerCase().includes(businessName.toLowerCase());
}

async function checkChatGPTMention(prompt, businessName) {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content || '';
    return textMentionsBusiness(text, businessName);
  } catch (err) {
    console.error('ChatGPT visibility check failed:', err.message);
    return null;
  }
}

async function checkPerplexityMention(prompt, businessName) {
  if (!process.env.PERPLEXITY_API_KEY) return null;
  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content || '';
    return textMentionsBusiness(text, businessName);
  } catch (err) {
    console.error('Perplexity visibility check failed:', err.message);
    return null;
  }
}

async function checkGeminiMention(prompt, businessName) {
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      }
    );
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return textMentionsBusiness(text, businessName);
  } catch (err) {
    console.error('Gemini visibility check failed:', err.message);
    return null;
  }
}

async function checkGrokMention(prompt, businessName) {
  if (!process.env.XAI_API_KEY) return null;
  try {
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.XAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'grok-4.6',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content || '';
    return textMentionsBusiness(text, businessName);
  } catch (err) {
    console.error('Grok visibility check failed:', err.message);
    return null;
  }
}

async function checkClaudeMention(prompt, businessName) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await response.json();
    const text = data?.content?.map((block) => block.text || '').join(' ') || '';
    return textMentionsBusiness(text, businessName);
  } catch (err) {
    console.error('Claude visibility check failed:', err.message);
    return null;
  }
}

// Runs all four platform checks for one listing and saves the result.
async function runAiVisibilityCheckForListing(listing) {
  const prompt = `What is the best option for "${listing.keyword}"? Please recommend a specific business by name.`;

  const [chatgpt, perplexity, gemini, grok, claude] = await Promise.all([
    checkChatGPTMention(prompt, listing.business_name),
    checkPerplexityMention(prompt, listing.business_name),
    checkGeminiMention(prompt, listing.business_name),
    checkGrokMention(prompt, listing.business_name),
    checkClaudeMention(prompt, listing.business_name),
  ]);

  await pool.query(
    `INSERT INTO ai_visibility_checks
       (tracked_listing_id, prompt_used, chatgpt_mentioned, perplexity_mentioned, gemini_mentioned, grok_mentioned, claude_mentioned, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      listing.id,
      prompt,
      chatgpt,
      perplexity,
      gemini,
      grok,
      claude,
      JSON.stringify({ chatgpt, perplexity, gemini, grok, claude }),
    ]
  );

  return { chatgpt, perplexity, gemini, grok, claude };
}

// ---------------------------------------------------------------------------
// GET /api/schema-check/:listingId   (auth required)
// Checks the listing's website for LocalBusiness schema. If missing,
// returns a ready-to-paste snippet built from data already on file.
// ---------------------------------------------------------------------------
app.get('/api/schema-check/:listingId', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(
      `SELECT * FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    const listing = listingResult.rows[0];
    if (!listing.website_url) {
      return res.status(400).json({ error: 'This listing does not have a website URL on file.' });
    }

    const result = await checkSchemaMarkup(listing.website_url);
    if (!result.found) {
      return res.status(502).json({ error: `Could not load the website to check: ${result.error}` });
    }

    res.json({
      hasLocalBusinessSchema: result.hasLocalBusinessSchema,
      foundTypes: result.foundTypes,
      suggestedSnippet: result.hasLocalBusinessSchema ? null : generateSchemaSnippet(listing),
    });
  } catch (err) {
    console.error('schema-check error:', err.message);
    res.status(500).json({ error: 'Schema check failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/ai-visibility?trackedListingId=...   (auth required)
// Returns the AI-mention check history for one listing, newest first.
// ---------------------------------------------------------------------------
app.get('/api/ai-visibility', requireAuth, async (req, res) => {
  try {
    const { trackedListingId } = req.query;
    if (!trackedListingId) {
      return res.status(400).json({ error: 'Missing trackedListingId' });
    }

    // Confirm ownership before returning anything.
    const listingResult = await pool.query(
      `SELECT id FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [trackedListingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    const result = await pool.query(
      `SELECT * FROM ai_visibility_checks WHERE tracked_listing_id = $1 ORDER BY checked_at DESC LIMIT 12`,
      [trackedListingId]
    );
    res.json({ checks: result.rows });
  } catch (err) {
    console.error('ai-visibility list error:', err.message);
    res.status(500).json({ error: 'Could not load AI visibility history' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/ai-visibility/:listingId/run   (auth required)
// Lets a customer trigger an AI visibility check for one of their own
// listings right now, instead of waiting for the weekly Tuesday run.
// ---------------------------------------------------------------------------
app.post('/api/ai-visibility/:listingId/run', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(
      `SELECT * FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    const result = await runAiVisibilityCheckForListing(listingResult.rows[0]);
    res.json({ result });
  } catch (err) {
    console.error('manual ai-visibility run error:', err.message);
    res.status(500).json({ error: 'Could not run AI visibility check' });
  }
});

// ---------------------------------------------------------------------------
// GBP POST GENERATOR
// Uses Claude to draft a short, ready-to-publish Google Business Profile
// update for a tracked listing. Kept short and promo-friendly since GBP
// posts perform best when brief and specific.
// ---------------------------------------------------------------------------
async function generateGbpPostContent(listing) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured.');
  }

  const prompt = `Write a short Google Business Profile post (an "update") for this business:
Business name: ${listing.business_name}
Location: ${listing.location}
What they're known for / tracked keyword: ${listing.keyword}

Requirements:
- 150-300 characters, upbeat and specific, not generic
- Include a light, natural call to action, but DO NOT assume the business has a physical storefront customers walk into — do not say things like "stop by," "visit us," or "come in." This business's format is unknown (it could be delivery-only, online-only, appointment-based, or a storefront). Use neutral action language instead, like "order today," "check us out," "get started," or "reach out."
- No hashtags, no emojis, no markdown formatting
- Return ONLY the post text, nothing else — no preamble, no quotation marks around it`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.json();
  const text = data?.content?.map((block) => block.text || '').join(' ').trim() || '';
  if (!text) throw new Error('AI did not return any post content.');
  return text;
}

// ---------------------------------------------------------------------------
// GBP POST IMAGE GENERATOR
// Uses OpenAI's image model to create an on-brand product/lifestyle photo
// to go with the post. Deliberately does NOT ask the model to render the
// business name as text in the image — AI image generators are unreliable
// at spelling out exact text/logos, so we avoid promising something that
// often comes out garbled.
// ---------------------------------------------------------------------------
async function generateGbpPostImage(listing) {
  if (!process.env.OPENAI_API_KEY) {
    return null; // Image generation is optional — skip quietly if not configured.
  }

  try {
    const imagePrompt = `A clean, appealing, professional product/lifestyle photo suitable for a small local business's Google Business Profile post. Business type/category: "${listing.keyword}". Warm, inviting, high-quality commercial photography style. Do not include any text, words, letters, or logos in the image.`;

    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt: imagePrompt,
        size: '1024x1024',
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('GBP post image generation — OpenAI returned an error:', JSON.stringify(data));
      return null;
    }

    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      console.error('GBP post image generation — no image data in response:', JSON.stringify(data));
    }
    return b64 || null;
  } catch (err) {
    console.error('GBP post image generation failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// POST /api/gbp-posts/:listingId/generate   (auth required)
// Generates a new AI-drafted GBP post for a listing and saves it as
// 'pending' for the customer to review.
// ---------------------------------------------------------------------------
app.post('/api/gbp-posts/:listingId/generate', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(
      `SELECT * FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    const listing = listingResult.rows[0];
    const [content, imageBase64] = await Promise.all([
      generateGbpPostContent(listing),
      generateGbpPostImage(listing),
    ]);

    const result = await pool.query(
      `INSERT INTO gbp_posts (tracked_listing_id, content, image_base64) VALUES ($1, $2, $3) RETURNING *`,
      [req.params.listingId, content, imageBase64]
    );

    res.json({ post: result.rows[0] });
  } catch (err) {
    console.error('generate gbp-post error:', err.message);
    res.status(500).json({ error: 'Could not generate a post right now.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/gbp-posts?trackedListingId=...   (auth required)
// Returns this listing's GBP post history, newest first.
// ---------------------------------------------------------------------------
app.get('/api/gbp-posts', requireAuth, async (req, res) => {
  try {
    const { trackedListingId } = req.query;
    if (!trackedListingId) {
      return res.status(400).json({ error: 'Missing trackedListingId' });
    }

    const listingResult = await pool.query(
      `SELECT id FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [trackedListingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    const result = await pool.query(
      `SELECT * FROM gbp_posts WHERE tracked_listing_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [trackedListingId]
    );
    res.json({ posts: result.rows });
  } catch (err) {
    console.error('list gbp-posts error:', err.message);
    res.status(500).json({ error: 'Could not load posts' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/gbp-posts/:id/approve   (auth required)
// PATCH /api/gbp-posts/:id/reject    (auth required)
// ---------------------------------------------------------------------------
app.patch('/api/gbp-posts/:id/approve', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE gbp_posts SET status = 'approved', decided_at = now()
       WHERE id = $1 AND tracked_listing_id IN (SELECT id FROM tracked_listings WHERE customer_id = $2)
       RETURNING *`,
      [req.params.id, req.customer.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    res.json({ post: result.rows[0] });
  } catch (err) {
    console.error('approve gbp-post error:', err.message);
    res.status(500).json({ error: 'Could not approve post' });
  }
});

app.patch('/api/gbp-posts/:id/reject', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE gbp_posts SET status = 'rejected', decided_at = now()
       WHERE id = $1 AND tracked_listing_id IN (SELECT id FROM tracked_listings WHERE customer_id = $2)
       RETURNING *`,
      [req.params.id, req.customer.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    res.json({ post: result.rows[0] });
  } catch (err) {
    console.error('reject gbp-post error:', err.message);
    res.status(500).json({ error: 'Could not reject post' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/gbp-audit?business=...&location=...
// Manual/on-demand version (the free tool + locked teaser on the site).
// ---------------------------------------------------------------------------
app.get('/api/gbp-audit', async (req, res) => {
  try {
    const { business, location } = req.query;
    if (!business || !location) {
      return res.status(400).json({ error: 'Missing ?business= or ?location=' });
    }

    const result = await runGbpAudit(business, location);
    if (!result.found) {
      return res.status(404).json({
        error: 'Could not find a matching Google Business Profile. Double-check the business name and location.',
        debug: result.taskStatus,
      });
    }

    res.json({
      business,
      location: result.fullLocation,
      rating: result.rating,
      reviewCount: result.reviewCount,
      findings: result.findings,
      locked: {
        issueCount: result.premiumFindings.length,
        message:
          result.premiumFindings.length > 0
            ? `We found ${result.premiumFindings.length} more issue${result.premiumFindings.length === 1 ? '' : 's'} affecting this listing's ranking. Sign up to see the full breakdown and start fixing them.`
            : `No additional issues found in this scan.`,
      },
    });
  } catch (err) {
    console.error('GBP audit error:', err.message);
    res.status(500).json({ error: 'GBP audit failed' });
  }
});

// ---------------------------------------------------------------------------
// AUTOMATED WEEKLY JOB
// Runs every Monday at 6am UTC. Re-checks every tracked listing belonging to
// an "active" (paying) customer, and stores the result in rank_history so
// customers see week-over-week trend data on their dashboard.
// ---------------------------------------------------------------------------
async function runWeeklyChecks() {
  console.log('Starting weekly rank/GBP check run...');
  try {
    const result = await pool.query(`
      SELECT tl.* FROM tracked_listings tl
      JOIN customers c ON c.id = tl.customer_id
      WHERE c.status = 'active'
    `);

    for (const listing of result.rows) {
      try {
        const rank = await runRankCheck(listing.keyword, listing.location, listing.business_name);
        const gbp = await runGbpAudit(listing.business_name, listing.location);

        await pool.query(
          `INSERT INTO rank_history (tracked_listing_id, local_pack_position, review_count, rating, raw)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            listing.id,
            rank.position,
            gbp.found ? gbp.reviewCount : null,
            gbp.found ? gbp.rating : null,
            JSON.stringify({ rank: rank.localPackItems, gbp }),
          ]
        );
        console.log(`Checked listing ${listing.id} (${listing.business_name}) — position: ${rank.position}`);
      } catch (err) {
        console.error(`Weekly check failed for listing ${listing.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Weekly check run error:', err.message);
  }
  console.log('Weekly rank/GBP check run complete.');
}

// Every Monday at 6:00 AM UTC.
cron.schedule('0 6 * * 1', runWeeklyChecks);

// ---------------------------------------------------------------------------
// AUTOMATED DAILY REVIEW-REQUEST JOB
// Runs every day at 9am UTC.
//   Step 1: sends the FIRST email to any review request that hasn't gotten
//           one yet.
//   Step 2: sends the SECOND (follow-up) email to any review request whose
//           first email went out 5+ days ago, hasn't been marked reviewed,
//           and hasn't gotten a second email yet.
// ---------------------------------------------------------------------------
async function runReviewRequestEmails() {
  console.log('Starting daily review-request email run...');

  try {
    // --- Step 1: first emails ---
    const firstBatch = await pool.query(`
      SELECT rr.*, tl.business_name, tl.review_link
      FROM review_requests rr
      JOIN tracked_listings tl ON tl.id = rr.tracked_listing_id
      WHERE rr.first_email_sent_at IS NULL
        AND rr.reviewed = false
        AND tl.review_link IS NOT NULL
    `);

    for (const req of firstBatch.rows) {
      try {
        await sendReviewRequestEmail({
          to: req.reviewer_email,
          reviewerName: req.reviewer_name,
          businessName: req.business_name,
          reviewLink: req.review_link,
          attempt: 1,
        });
        await pool.query(
          `UPDATE review_requests SET first_email_sent_at = now() WHERE id = $1`,
          [req.id]
        );
        console.log(`Sent first review-request email to ${req.reviewer_email} (request ${req.id})`);
      } catch (err) {
        console.error(`Failed to send first review email for request ${req.id}:`, err.message);
      }
    }

    // --- Step 2: follow-up emails, 5+ days after the first ---
    const secondBatch = await pool.query(`
      SELECT rr.*, tl.business_name, tl.review_link
      FROM review_requests rr
      JOIN tracked_listings tl ON tl.id = rr.tracked_listing_id
      WHERE rr.first_email_sent_at IS NOT NULL
        AND rr.first_email_sent_at <= now() - INTERVAL '5 days'
        AND rr.second_email_sent_at IS NULL
        AND rr.reviewed = false
        AND tl.review_link IS NOT NULL
    `);

    for (const req of secondBatch.rows) {
      try {
        await sendReviewRequestEmail({
          to: req.reviewer_email,
          reviewerName: req.reviewer_name,
          businessName: req.business_name,
          reviewLink: req.review_link,
          attempt: 2,
        });
        await pool.query(
          `UPDATE review_requests SET second_email_sent_at = now() WHERE id = $1`,
          [req.id]
        );
        console.log(`Sent follow-up review-request email to ${req.reviewer_email} (request ${req.id})`);
      } catch (err) {
        console.error(`Failed to send follow-up review email for request ${req.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Review-request email run error:', err.message);
  }

  console.log('Daily review-request email run complete.');
}

// Every day at 9:00 AM UTC.
cron.schedule('0 9 * * *', runReviewRequestEmails);

// ---------------------------------------------------------------------------
// AUTOMATED WEEKLY AI VISIBILITY CHECK
// Runs every Tuesday at 6am UTC (a day after the rank/GBP check, so the two
// jobs don't compete for resources). Asks ChatGPT, Perplexity, Gemini, and
// Grok a realistic buyer-style question for every active customer's
// tracked listing, and records whether the business got mentioned.
// ---------------------------------------------------------------------------
async function runWeeklyAiVisibilityChecks() {
  console.log('Starting weekly AI visibility check run...');
  try {
    const result = await pool.query(`
      SELECT tl.* FROM tracked_listings tl
      JOIN customers c ON c.id = tl.customer_id
      WHERE c.status = 'active'
    `);

    for (const listing of result.rows) {
      try {
        const checkResult = await runAiVisibilityCheckForListing(listing);
        console.log(`AI visibility checked for listing ${listing.id} (${listing.business_name}):`, checkResult);
      } catch (err) {
        console.error(`AI visibility check failed for listing ${listing.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Weekly AI visibility check run error:', err.message);
  }
  console.log('Weekly AI visibility check run complete.');
}

// Every Tuesday at 6:00 AM UTC.
cron.schedule('0 6 * * 2', runWeeklyAiVisibilityChecks);

// ---------------------------------------------------------------------------
// POST /api/admin/run-checks-now?secret=...
// Manual trigger for testing the weekly job without waiting a week. Protect
// with an ADMIN_SECRET env var so random people can't burn your DataForSEO
// credit by hitting this endpoint.
// ---------------------------------------------------------------------------
app.post('/api/admin/run-checks-now', async (req, res) => {
  if (!process.env.ADMIN_SECRET || req.query.secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  runWeeklyChecks(); // fire and forget — this can take a while for many listings
  res.json({ message: 'Weekly check run started. Check Railway logs for progress.' });
});

// ---------------------------------------------------------------------------
// POST /api/admin/run-review-emails-now?secret=...
// Manual trigger for testing the review-request email job without waiting
// for the daily 9am UTC run. Same ADMIN_SECRET protection as above.
// ---------------------------------------------------------------------------
app.post('/api/admin/run-review-emails-now', async (req, res) => {
  if (!process.env.ADMIN_SECRET || req.query.secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  runReviewRequestEmails(); // fire and forget
  res.json({ message: 'Review-request email run started. Check Railway logs for progress.' });
});

// ---------------------------------------------------------------------------
// POST /api/admin/run-ai-visibility-now?secret=...
// Manual trigger for testing the AI visibility job without waiting for the
// weekly run. Same ADMIN_SECRET protection as the other admin endpoints.
// ---------------------------------------------------------------------------
app.post('/api/admin/run-ai-visibility-now', async (req, res) => {
  if (!process.env.ADMIN_SECRET || req.query.secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  runWeeklyAiVisibilityChecks(); // fire and forget — calls 4 AI APIs per listing, can take a while
  res.json({ message: 'AI visibility check run started. Check Railway logs for progress.' });
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`RankHighPro backend running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err.message);
    process.exit(1);
  });

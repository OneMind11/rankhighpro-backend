// RankHighPro Backend
// Handles: Stripe subscription checkout, payment webhooks,
// live PageSpeed audits, and DataForSEO rank checks.
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

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Stripe webhooks need the RAW request body, so this route is registered
// BEFORE express.json() runs on everything else.
app.post(
  '/webhook/stripe',
  express.raw({ type: 'application/json' }),
  (req, res) => {
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

    // This is where you react to real payment events.
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        console.log('New subscription started:', session.customer_email, session.id);
        // TODO: save this customer to your database, mark them "active"
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        console.log('Subscription canceled:', sub.id);
        // TODO: mark this customer "canceled" in your database
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.log('Payment failed for:', invoice.customer_email);
        // TODO: email the customer, flag account
        break;
      }
      default:
        console.log('Unhandled Stripe event:', event.type);
    }

    res.json({ received: true });
  }
);

// Everything else can safely parse JSON normally.
app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json());
app.use(express.static('public'));

// ---------------------------------------------------------------------------
// PRICING TIERS
// Defined here in code so you don't have to manually create "Products" in
// the Stripe dashboard. Stripe will create them on the fly at checkout time.
// ---------------------------------------------------------------------------
const PLANS = {
  watch: { name: 'RankHighPro Watch', amountCents: 4900 },
  grow: { name: 'RankHighPro Grow', amountCents: 14900 },
  managed: { name: 'RankHighPro Managed', amountCents: 39900 },
};

// ---------------------------------------------------------------------------
// POST /api/create-checkout-session
// Called when someone clicks "Start Watch / Grow / Managed" on the site.
// Body: { plan: "watch" | "grow" | "managed", email?: string }
// ---------------------------------------------------------------------------
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { plan, email } = req.body;
    const selected = PLANS[plan];

    if (!selected) {
      return res.status(400).json({ error: 'Unknown plan: ' + plan });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email || undefined,
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
// Runs a real Google PageSpeed Insights check and returns a simplified score.
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

    // Pull out a few plain-English findings from the raw Lighthouse audit data.
    const findings = [];
    if (audits['is-crawlable'] && audits['is-crawlable'].score !== 1) {
      findings.push({
        severity: 'error',
        message: "Googlebot may not be able to crawl this page properly.",
      });
    }
    if (audits['largest-contentful-paint']) {
      const lcp = audits['largest-contentful-paint'].numericValue / 1000;
      if (lcp > 4) {
        findings.push({
          severity: 'warn',
          message: `Largest Contentful Paint is ${lcp.toFixed(1)}s — aim for under 2.5s.`,
        });
      }
    }
    if (audits['structured-data'] && audits['structured-data'].score !== 1) {
      findings.push({
        severity: 'warn',
        message: 'Structured data (schema markup) may be missing or invalid.',
      });
    }

    res.json({
      url: targetUrl,
      score: perfScore,
      findings,
    });
  } catch (err) {
    console.error('PageSpeed audit error:', err.message);
    res.status(500).json({ error: 'Audit failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/rank-check?keyword=kratom+in+tucson&location=Tucson,Arizona
// Uses DataForSEO's SERP API to check local pack ranking for a keyword.
// NOTE: this spends real DataForSEO credit every time it's called — call it
// on a schedule (e.g. weekly, via a cron job), not on every page load.
// ---------------------------------------------------------------------------
app.get('/api/rank-check', async (req, res) => {
  try {
    const { keyword, location } = req.query;
    if (!keyword || !location) {
      return res.status(400).json({ error: 'Missing ?keyword= or ?location=' });
    }

    const auth = Buffer.from(
      `${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`
    ).toString('base64');

    const response = await fetch(
      'https://api.dataforseo.com/v3/serp/google/organic/live/advanced',
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([
          {
            keyword,
            location_name: location,
            language_code: 'en',
            device: 'mobile',
          },
        ]),
      }
    );

    const data = await response.json();
    const items = data?.tasks?.[0]?.result?.[0]?.items || [];
    const localPack = items.find((i) => i.type === 'local_pack');

    res.json({
      keyword,
      location,
      localPackResults: localPack ? localPack.items : [],
      raw: undefined, // omit raw payload from the response to keep it light
    });
  } catch (err) {
    console.error('Rank check error:', err.message);
    res.status(500).json({ error: 'Rank check failed' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RankHighPro backend running on port ${PORT}`);
});

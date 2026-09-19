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
  // Lets us tell what TYPE of business a listing is (e.g. "kratom retailer",
  // "house cleaning service"), separate from the specific search keyword.
  // Used to enforce local exclusivity on Grow/Pro (see
  // checkExclusivity below) — Watch has no exclusivity restriction.
  await pool.query(`
    ALTER TABLE tracked_listings ADD COLUMN IF NOT EXISTS business_category TEXT;
  `);
  // Adds the review_link column to tracked_listings if this table already
  // existed before this feature was added (safe to run every time).
  await pool.query(`
    ALTER TABLE tracked_listings ADD COLUMN IF NOT EXISTS review_link TEXT;
    -- Extracted automatically from review_link (the ?placeid=... part of a
    -- Google review link). Lets rank/audit checks match this listing's
    -- EXACT Google Business Profile instead of a fuzzy name search — fixes
    -- mismatches from naming variations, duplicate listings, or spelling.
    ALTER TABLE tracked_listings ADD COLUMN IF NOT EXISTS google_place_id TEXT;
  `);
  // ---------------------------------------------------------------------
  // WAITLIST
  // When someone wants Grow or Pro but a local competitor of the same
  // business_category already holds that exclusive spot, they can join a
  // waitlist instead of being blocked outright. The moment the spot opens
  // up (the holder cancels, goes past due, or removes that listing), the
  // oldest 'waiting' entry for that category+location gets emailed and
  // texted automatically. See notifyWaitlistIfSpotOpen() below.
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS waitlist_entries (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      phone TEXT,
      business_name TEXT NOT NULL,
      business_category TEXT NOT NULL,
      location TEXT NOT NULL,
      plan_interested TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      notified_at TIMESTAMPTZ
    );
  `);
  // Lets a customer link their own Facebook, Instagram, and X profiles to
  // a tracked listing (available on every tier). Currently just stored and
  // displayed — not used for auto-publishing since that requires separate
  // platform API approvals.
  await pool.query(`
    ALTER TABLE tracked_listings ADD COLUMN IF NOT EXISTS facebook_url TEXT;
  `);
  await pool.query(`
    ALTER TABLE tracked_listings ADD COLUMN IF NOT EXISTS instagram_url TEXT;
  `);
  await pool.query(`
    ALTER TABLE tracked_listings ADD COLUMN IF NOT EXISTS x_url TEXT;
    ALTER TABLE tracked_listings ADD COLUMN IF NOT EXISTS website_builder TEXT;
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
  // REVIEW REPLIES (Grow & Pro)
  // One row per actual Google review we've pulled for a listing, paired
  // with an AI-drafted reply. review_id is DataForSEO's own unique ID for
  // that review, so re-fetching the same review on the next check never
  // creates a duplicate row or re-drafts a reply that's already there.
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS review_replies (
      id SERIAL PRIMARY KEY,
      tracked_listing_id INTEGER NOT NULL REFERENCES tracked_listings(id) ON DELETE CASCADE,
      review_id TEXT NOT NULL,
      reviewer_name TEXT,
      rating INTEGER,
      review_text TEXT,
      review_time TEXT,
      ai_draft_reply TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(tracked_listing_id, review_id)
    );
  `);
  // ---------------------------------------------------------------------
  // BACKLINK OPPORTUNITIES (Pro exclusive)
  // AI-generated, personalized list of realistic places this specific
  // business could get a link back to their website — local directories,
  // chambers of commerce, community sites, partner/supplier businesses,
  // guest-post-friendly local blogs, sponsorship opportunities, etc. Each
  // comes with a ready-to-send outreach message. Generated once per
  // listing (regenerable), then tracked like a checklist as the customer
  // works through it.
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS backlink_opportunities (
      id SERIAL PRIMARY KEY,
      tracked_listing_id INTEGER NOT NULL REFERENCES tracked_listings(id) ON DELETE CASCADE,
      opportunity_name TEXT NOT NULL,
      opportunity_type TEXT,
      why_it_helps TEXT,
      how_to_contact TEXT,
      outreach_template TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // ---------------------------------------------------------------------
  // BEAT THIS COMPETITOR REPORTS (Pro exclusive)
  // Customer picks a specific competitor from their local pack; we pull a
  // fresh GBP snapshot on that one business (same cheap internal audit
  // call used everywhere else) and have Claude write a concrete,
  // side-by-side plan to pass them specifically. Cached per
  // (listing, competitor) pair so re-selecting the same competitor is
  // instant instead of re-generating.
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS competitor_reports (
      id SERIAL PRIMARY KEY,
      tracked_listing_id INTEGER NOT NULL REFERENCES tracked_listings(id) ON DELETE CASCADE,
      competitor_name TEXT NOT NULL,
      competitor_position INTEGER,
      competitor_review_count INTEGER,
      competitor_rating NUMERIC,
      report_text TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(tracked_listing_id, competitor_name)
    );
  `);
  // ---------------------------------------------------------------------
  // KEYWORD SUGGESTIONS (all tiers)
  // AI-generated alternate/additional keyword ideas for this business,
  // each paired with the concrete change needed to actually have a shot
  // at ranking for it (title tag, meta description, GBP category, GBP
  // description). Recommendations only — nothing is applied automatically
  // yet, since that requires GBP API write access we don't have approved.
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS keyword_suggestions (
      id SERIAL PRIMARY KEY,
      tracked_listing_id INTEGER NOT NULL REFERENCES tracked_listings(id) ON DELETE CASCADE,
      keyword TEXT NOT NULL,
      why_it_helps TEXT,
      title_tag_suggestion TEXT,
      meta_description_suggestion TEXT,
      gbp_category_suggestion TEXT,
      gbp_description_suggestion TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // ---------------------------------------------------------------------
  // TRACKED KEYWORDS (extra keywords beyond a listing's primary one)
  // A listing's main `keyword` column stays as-is — this table holds
  // ADDITIONAL keywords a customer chooses to track (usually picked from
  // Keyword Opportunities), each with its own current + previous local
  // pack position so movement over time is visible per keyword. Checked
  // on the same schedule as the listing itself. Tier-limited via
  // TIER_LIMITS.extraKeywordsLimit since each one adds a real ongoing
  // DataForSEO cost on every check cycle.
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracked_keywords (
      id SERIAL PRIMARY KEY,
      tracked_listing_id INTEGER NOT NULL REFERENCES tracked_listings(id) ON DELETE CASCADE,
      keyword TEXT NOT NULL,
      local_pack_position INTEGER,
      previous_position INTEGER,
      last_checked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(tracked_listing_id, keyword)
    );
  `);
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
  // Added later: an AI-generated, prioritized action plan for getting
  // mentioned by the platforms that didn't mention the business yet.
  // Cached on the check row itself so we don't regenerate (and re-spend
  // an Anthropic API call) every time the customer opens the dashboard.
  await pool.query(`ALTER TABLE ai_visibility_checks ADD COLUMN IF NOT EXISTS game_plan TEXT;`);
  await pool.query(`ALTER TABLE ai_visibility_checks ADD COLUMN IF NOT EXISTS game_plan_generated_at TIMESTAMPTZ;`);
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
  // Stores the reason image generation failed, if it did, so the customer
  // can see it directly in the dashboard without needing server logs.
  await pool.query(`
    ALTER TABLE gbp_posts ADD COLUMN IF NOT EXISTS image_error TEXT;
  `);
  // ---------------------------------------------------------------------
  // SOCIAL ADS (Facebook / Instagram)
  // AI-drafted ad creative: headline, body copy, and a suggested
  // call-to-action button label. Same pending/approved/rejected flow as
  // GBP posts. No Meta Marketing API auto-publish — customer boosts the
  // post or builds it manually in Ads Manager using this copy + photo.
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS social_ads (
      id SERIAL PRIMARY KEY,
      tracked_listing_id INTEGER NOT NULL REFERENCES tracked_listings(id) ON DELETE CASCADE,
      headline TEXT NOT NULL,
      body_text TEXT NOT NULL,
      cta TEXT NOT NULL,
      image_base64 TEXT,
      image_error TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      decided_at TIMESTAMPTZ
    );
  `);
  // ---------------------------------------------------------------------
  // X (TWITTER) POSTS
  // AI-drafted post text, hard-capped under 280 characters, plus a
  // landscape image sized to match X's card format. Same pending/approved
  // /rejected flow as GBP posts and social ads. No X Ads API — fully
  // manual copy/paste posting instructions only.
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS x_posts (
      id SERIAL PRIMARY KEY,
      tracked_listing_id INTEGER NOT NULL REFERENCES tracked_listings(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      image_base64 TEXT,
      image_error TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      decided_at TIMESTAMPTZ
    );
  `);
  // ---------------------------------------------------------------------
  // COMMUNITY POSTS (Reddit / Quora / Nextdoor)
  // AI-drafted posts formatted for the platform + tone AI search tools
  // (ChatGPT, Perplexity) cite most often. Same pending/approved/rejected
  // copy/paste flow as GBP posts, social ads, and X posts — deliberately
  // NO auto-posting API. Reddit and Quora both detect and ban accounts
  // that auto-post promotional content, so keeping this manual protects
  // the customer's account as much as it protects us from building
  // something that gets flagged as spam.
  // post_type cycles through storytelling / did_you_know / update /
  // promotion so customers aren't just handed a wall of sales pitches.
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_posts (
      id SERIAL PRIMARY KEY,
      tracked_listing_id INTEGER NOT NULL REFERENCES tracked_listings(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      post_type TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      decided_at TIMESTAMPTZ
    );
  `);
  // Lets a customer tell us which subreddit(s) fit their business and any
  // notes on brand voice, so Reddit posts aren't generic and don't get
  // removed by moderators for being posted in the wrong community.
  await pool.query(`
    ALTER TABLE tracked_listings ADD COLUMN IF NOT EXISTS reddit_subreddit TEXT;
    ALTER TABLE tracked_listings ADD COLUMN IF NOT EXISTS community_notes TEXT;
  `);
  // ---------------------------------------------------------------------
  // AUTO-FIX TICKETS (Pro tier)
  // When a scheduled check on a Pro listing finds something we can
  // generate an exact fix for (schema markup, keyword-in-title/meta), we
  // open a ticket here and email the RankHighPro team the ready-to-apply
  // fix — instead of just showing the customer a checklist. One open
  // ticket per listing+issue at a time so daily Pro checks don't spam
  // the same alert. Resolved automatically once the check no longer finds
  // the issue.
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auto_fix_tickets (
      id SERIAL PRIMARY KEY,
      tracked_listing_id INTEGER NOT NULL REFERENCES tracked_listings(id) ON DELETE CASCADE,
      issue_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      fix_detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ
    );
  `);

  // ---------------------------------------------------------------------
  // WORDPRESS CONNECTIONS (Pro tier)
  // Stores an encrypted WordPress "Application Password" — a scoped,
  // revocable credential WordPress itself provides for exactly this kind
  // of third-party access (it is NOT the customer's real admin password).
  // Lets the Pro auto-fix system apply schema markup fixes live,
  // automatically, on connected WordPress sites.
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wordpress_connections (
      id SERIAL PRIMARY KEY,
      tracked_listing_id INTEGER NOT NULL REFERENCES tracked_listings(id) ON DELETE CASCADE,
      site_url TEXT NOT NULL,
      wp_username TEXT NOT NULL,
      wp_app_password TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      connected_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // ---------------------------------------------------------------------
  // SUPPORT CHAT MESSAGES (Watch & Grow)
  // One row per message sent to the AI assistant, used only to enforce
  // the monthly message limit per tier.
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS support_chat_messages (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // ---------------------------------------------------------------------
  // DIRECT MESSAGES (Fully Managed By Us tier)
  // A simple two-way message log between a Fully Managed By Us customer
  // and the RankHighPro team. Customer sends via the dashboard; we get
  // emailed and reply from wherever's convenient (email, or by writing a
  // reply row here later via an admin endpoint).
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS direct_messages (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      sender TEXT NOT NULL DEFAULT 'customer',
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // ---------------------------------------------------------------------
  // HOSTED SITES (Grow & Pro)
  // Tracks a website RankHighPro built and deployed on the customer's
  // behalf via Netlify, for customers without a website of their own.
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hosted_sites (
      id SERIAL PRIMARY KEY,
      tracked_listing_id INTEGER NOT NULL REFERENCES tracked_listings(id) ON DELETE CASCADE,
      netlify_site_id TEXT NOT NULL,
      site_name TEXT NOT NULL,
      site_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'live',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // ---------------------------------------------------------------------
  // CUSTOMER'S OWN TWILIO CONNECTION
  // Lets a RankHighPro customer connect their OWN Twilio account (their
  // Account SID, Auth Token, and phone number) so text campaigns bill to
  // them directly — not to RankHighPro. Same encrypted-credential pattern
  // as the WordPress connection.
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS twilio_connections (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      account_sid TEXT NOT NULL,
      auth_token TEXT NOT NULL,
      phone_number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      connected_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // ---------------------------------------------------------------------
  // CUSTOMER CONTACTS (for text campaigns)
  // Manually entered by the business owner — RankHighPro has no way to
  // capture these automatically (Google never exposes customer contact
  // info to third-party tools). consent_confirmed is required at entry
  // time; opted_out flips true if that contact ever replies STOP.
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_contacts (
      id SERIAL PRIMARY KEY,
      tracked_listing_id INTEGER NOT NULL REFERENCES tracked_listings(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      consent_confirmed BOOLEAN NOT NULL DEFAULT false,
      opted_out BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // ---------------------------------------------------------------------
  // SMS CAMPAIGNS (history log)
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sms_campaigns (
      id SERIAL PRIMARY KEY,
      tracked_listing_id INTEGER NOT NULL REFERENCES tracked_listings(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      recipient_count INTEGER NOT NULL,
      sent_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // ---------------------------------------------------------------------
  // CAMPAIGN MEDIA
  // Holds an image (AI-generated or uploaded) for an MMS campaign. Served
  // through a public, unauthenticated endpoint below, since Twilio's own
  // servers fetch the image directly by URL — they can't use our login
  // tokens.
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaign_media (
      id SERIAL PRIMARY KEY,
      tracked_listing_id INTEGER NOT NULL REFERENCES tracked_listings(id) ON DELETE CASCADE,
      image_base64 TEXT NOT NULL,
      media_type TEXT NOT NULL DEFAULT 'image/png',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Adds an email field to the shared contact list so the same contacts
  // can be used for both text and email campaigns.
  await pool.query(`
    ALTER TABLE customer_contacts ADD COLUMN IF NOT EXISTS email TEXT;
  `);
  await pool.query(`
    ALTER TABLE customer_contacts ADD COLUMN IF NOT EXISTS email_opted_out BOOLEAN NOT NULL DEFAULT false;
  `);
  // ---------------------------------------------------------------------
  // CUSTOMER'S OWN RESEND CONNECTION (for email campaigns)
  // Same pattern as the Twilio connection — every customer connects and
  // pays for their own Resend account, using their own verified sending
  // domain, so campaigns never bill to or risk RankHighPro's own sending
  // reputation.
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS resend_connections (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      api_key TEXT NOT NULL,
      from_email TEXT NOT NULL,
      from_name TEXT NOT NULL,
      mailing_address TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      connected_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // ---------------------------------------------------------------------
  // EMAIL CAMPAIGNS (history log)
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_campaigns (
      id SERIAL PRIMARY KEY,
      tracked_listing_id INTEGER NOT NULL REFERENCES tracked_listings(id) ON DELETE CASCADE,
      subject TEXT NOT NULL,
      body_html TEXT NOT NULL,
      recipient_count INTEGER NOT NULL,
      sent_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // ---------------------------------------------------------------------
  // SOCIAL MEDIA MARKETING POSTS (Grow & Pro)
  // Organic social content — not paid ad creative (that's social_ads).
  // `goal` drives what kind of post AI writes: a sale, a product update,
  // a general post, a storytelling post, or a "did you know" post. Same
  // pending/approved/rejected flow as everything else — rejecting one
  // immediately generates a fresh replacement.
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS social_media_posts (
      id SERIAL PRIMARY KEY,
      tracked_listing_id INTEGER NOT NULL REFERENCES tracked_listings(id) ON DELETE CASCADE,
      goal TEXT NOT NULL,
      caption TEXT NOT NULL,
      image_base64 TEXT,
      image_error TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      decided_at TIMESTAMPTZ
    );
  `);
  // ---------------------------------------------------------------------
  // CITATION CHECKLIST (Grow & Pro)
  // Tracks which directories (Yelp, Apple Maps, Bing Places, etc.) the
  // customer has manually confirmed their NAP is consistent on. There's
  // no way to auto-submit to these directories — no legitimate third-
  // party API for it exists — so this is a guided checklist, not an
  // automated connector.
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS citation_checklist (
      id SERIAL PRIMARY KEY,
      tracked_listing_id INTEGER NOT NULL REFERENCES tracked_listings(id) ON DELETE CASCADE,
      directory_name TEXT NOT NULL,
      completed BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(tracked_listing_id, directory_name)
    );
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

// ---------------------------------------------------------------------------
// SCHEDULED CHECK REPORT EMAIL
// Builds a branded HTML report matching the RankHighPro site's look (dark
// navy header, cream background, red/green/amber accents) and emails it to
// the customer after each scheduled check. Shows their position, who's
// outranking them, and a plain-English list of what to fix. The same data
// (competitors + findings) is already saved in rank_history.raw, so the
// dashboard can render an identical breakdown without needing this HTML
// stored separately.
// ---------------------------------------------------------------------------
function buildRankReportEmailHtml({
  businessName, plan, cadenceLabel, checkDateLabel,
  position, reviewCount, rating, competitors, competitorDetails, findings, dashboardUrl,
}) {
  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
  const positionText = position ? `#${position} in the local map pack` : 'not currently in the local map pack';
  const positionColor = position && position <= 3 ? '#4FAE7A' : (position ? '#E8A33D' : '#E2483D');

  const competitorRows = (competitors || [])
    .filter((c) => (c.title || '').toLowerCase() !== businessName.toLowerCase())
    .slice(0, 5)
    .map((c, i) => `
      <tr>
        <td style="padding:8px 0; border-bottom:1px solid #eee; font-family:Arial,Helvetica,sans-serif; font-size:14px; color:#12212E;">${i + 1}. ${c.title || 'Unknown business'}</td>
        <td style="padding:8px 0; border-bottom:1px solid #eee; font-family:Arial,Helvetica,sans-serif; font-size:13px; color:#666666; text-align:right; white-space:nowrap;">${c.rating && c.rating.value ? c.rating.value + '★' : ''}${c.rating && c.rating.votes_count ? ' · ' + c.rating.votes_count + ' reviews' : ''}</td>
      </tr>
    `).join('');

  // Competitor deep-scan gap analysis — how far behind the toughest
  // competitor you actually are, in plain numbers.
  let gapText = '';
  const validCompetitors = (competitorDetails || []).filter((c) => c.reviewCount != null);
  if (validCompetitors.length > 0) {
    const toughest = validCompetitors.reduce((a, b) => (b.reviewCount > a.reviewCount ? b : a));
    const myReviews = reviewCount || 0;
    if (toughest.reviewCount > myReviews) {
      gapText = `To catch <strong>${toughest.name}</strong> (${toughest.reviewCount} reviews${toughest.rating ? ', ' + toughest.rating + '★' : ''}), you need roughly <strong>${toughest.reviewCount - myReviews} more reviews</strong> at your current pace.`;
    } else {
      gapText = `You already have more reviews than every competitor we scanned in this search — keep the streak going.`;
    }
  }

  const findingRows = (findings || []).length > 0
    ? findings.map((f) => `
        <tr>
          <td style="padding:10px 0; border-bottom:1px solid #f0f0f0; font-family:Arial,Helvetica,sans-serif; font-size:14px; color:#12212E; vertical-align:top;">
            <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${f.severity === 'error' ? '#E2483D' : '#E8A33D'}; margin-right:8px;"></span>${f.message}
            ${f.fix ? `<div style="margin:6px 0 0 16px; font-size:12.5px; color:#555555; white-space:pre-line;">${f.fix}</div>` : ''}
          </td>
        </tr>
      `).join('')
    : `<tr><td style="padding:6px 0; font-family:Arial,Helvetica,sans-serif; font-size:14px; color:#4FAE7A;">No issues found in this check — nice work.</td></tr>`;

  return `
  <div style="background:#F6F1E4; padding:32px 16px; font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" style="max-width:560px; margin:0 auto; border-collapse:collapse;">
      <tr>
        <td style="background:#12212E; border-radius:14px 14px 0 0; padding:28px 28px 20px;">
          <div style="font-family:Georgia,'Times New Roman',serif; font-weight:bold; font-size:20px; color:#F6F1E4;">
            <span style="color:#E2483D;">●</span> RankHighPro
          </div>
          <div style="font-family:Arial,Helvetica,sans-serif; font-size:11px; letter-spacing:1px; text-transform:uppercase; color:rgba(246,241,228,0.55); margin-top:6px;">
            ${planLabel} plan &middot; ${cadenceLabel} report &middot; ${checkDateLabel}
          </div>
        </td>
      </tr>
      <tr>
        <td style="background:#ffffff; border-radius:0 0 14px 14px; padding:28px;">
          <div style="font-family:Georgia,'Times New Roman',serif; font-size:22px; color:#12212E; margin-bottom:4px;">${businessName}</div>
          <div style="font-family:Arial,Helvetica,sans-serif; font-size:15px; color:${positionColor}; font-weight:bold; margin-bottom:22px;">
            ${positionText}${reviewCount != null ? ` · ${reviewCount} reviews${rating ? ' · ' + rating + '★' : ''}` : ''}
          </div>

          ${competitorRows ? `
          <div style="font-family:Arial,Helvetica,sans-serif; font-size:12px; text-transform:uppercase; letter-spacing:0.5px; color:#999999; margin-bottom:8px;">Who's ranking in this search</div>
          <table role="presentation" width="100%" style="border-collapse:collapse; margin-bottom:16px;">${competitorRows}</table>
          ` : ''}

          ${gapText ? `
          <div style="background:#F6F1E4; border-radius:8px; padding:14px 16px; margin-bottom:24px; font-family:Arial,Helvetica,sans-serif; font-size:13.5px; color:#12212E; line-height:1.5;">${gapText}</div>
          ` : ''}

          <div style="font-family:Arial,Helvetica,sans-serif; font-size:12px; text-transform:uppercase; letter-spacing:0.5px; color:#999999; margin-bottom:8px;">What to fix to rank higher</div>
          <table role="presentation" width="100%" style="border-collapse:collapse; margin-bottom:24px;">${findingRows}</table>

          <a href="${dashboardUrl}" style="display:inline-block; background:#E2483D; color:#ffffff; text-decoration:none; padding:12px 22px; border-radius:8px; font-family:Arial,Helvetica,sans-serif; font-weight:bold; font-size:14px;">View full report in your dashboard →</a>
        </td>
      </tr>
    </table>
    <div style="max-width:560px; margin:16px auto 0; text-align:center; font-family:Arial,Helvetica,sans-serif; font-size:12px; color:rgba(18,33,46,0.45);">
      RankHighPro is built to do everything possible to get your listing ranking higher and the phone ringing.
    </div>
  </div>
  `;
}

// Sends the RankHighPro team a ready-to-apply fix for a Pro customer,
// and opens a ticket so we don't send the same alert again while it's
// still unresolved. Called only for issue types we can generate an exact
// fix for (schema markup, keyword-in-title/meta) — anything else stays a
// checklist item even on Pro, since there's nothing concrete to hand
// the team yet.
async function queueManagedAutoFix({ listingId, businessName, websiteUrl, issueType, fixDetail }) {
  try {
    const existing = await pool.query(
      `SELECT id FROM auto_fix_tickets WHERE tracked_listing_id = $1 AND issue_type = $2 AND status = 'open' LIMIT 1`,
      [listingId, issueType]
    );
    if (existing.rows.length > 0) return; // already an open ticket for this — don't re-notify

    await pool.query(
      `INSERT INTO auto_fix_tickets (tracked_listing_id, issue_type, fix_detail) VALUES ($1, $2, $3)`,
      [listingId, issueType, fixDetail]
    );

    if (!process.env.ADMIN_NOTIFY_EMAIL) {
      console.warn('ADMIN_NOTIFY_EMAIL not set — auto-fix ticket opened but no email sent.');
      return;
    }
    if (!process.env.RESEND_API_KEY) {
      console.warn('RESEND_API_KEY not set — auto-fix ticket opened but no email sent.');
      return;
    }

    const html = `
      <p><strong>Pro customer auto-fix ready to apply</strong></p>
      <p>Business: ${businessName}${websiteUrl ? ` — <a href="${websiteUrl.startsWith('http') ? websiteUrl : 'https://' + websiteUrl}">${websiteUrl}</a>` : ''}</p>
      <p>Issue: ${issueType}</p>
      <pre style="background:#f4f4f4; padding:12px; border-radius:6px; white-space:pre-wrap; font-size:13px;">${fixDetail}</pre>
      <p>This is a Pro-tier customer — apply this fix directly and mark it resolved once done.</p>
    `;

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL || 'RankHighPro <onboarding@resend.dev>',
        to: process.env.ADMIN_NOTIFY_EMAIL,
        subject: `[Pro auto-fix] ${businessName} — ${issueType}`,
        html,
      }),
    });
  } catch (err) {
    console.error('queueManagedAutoFix error:', err.message);
  }
}

// Marks any open auto-fix tickets for this listing+issue as resolved —
// called once a check finds the issue no longer present.
async function resolveManagedAutoFix(listingId, issueType) {
  try {
    await pool.query(
      `UPDATE auto_fix_tickets SET status = 'resolved', resolved_at = now()
       WHERE tracked_listing_id = $1 AND issue_type = $2 AND status = 'open'`,
      [listingId, issueType]
    );
  } catch (err) {
    console.error('resolveManagedAutoFix error:', err.message);
  }
}

async function sendRankCheckReportEmail({
  to, businessName, plan, cadenceLabel, checkDateLabel,
  position, reviewCount, rating, competitors, competitorDetails, findings,
}) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — report not emailed. Would have sent to:', to);
    return;
  }

  const html = buildRankReportEmailHtml({
    businessName, plan, cadenceLabel, checkDateLabel,
    position, reviewCount, rating, competitors, competitorDetails, findings,
    dashboardUrl: `${FRONTEND_URL}/dashboard.html`,
  });

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL || 'RankHighPro <onboarding@resend.dev>',
      to,
      subject: `Your ${cadenceLabel.toLowerCase()} RankHighPro report — ${businessName}`,
      html,
    }),
  });
}

// ---------------------------------------------------------------------------
// INSTANT RANK-DROP ALERT (Grow & Pro only)
// Fires immediately — outside the normal report cadence — the moment a
// check finds the business worse off than its last check: fell out of the
// map pack entirely, or dropped to a worse position. Watch customers only
// hear about changes in their next scheduled weekly report; this is a real
// selling point for Grow/Pro.
// ---------------------------------------------------------------------------
async function sendRankDropAlertEmail({ to, businessName, previousPosition, newPosition, dashboardUrl }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — drop alert not emailed. Would have sent to:', to);
    return;
  }

  const wasRanked = previousPosition !== null && previousPosition !== undefined;
  const nowRanked = newPosition !== null && newPosition !== undefined;
  const changeText = !nowRanked
    ? `dropped out of the local map pack entirely${wasRanked ? ` (was #${previousPosition})` : ''}`
    : `slipped from #${previousPosition} to #${newPosition}`;

  const html = `
  <div style="background:#F6F1E4; padding:32px 16px; font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" style="max-width:560px; margin:0 auto; border-collapse:collapse;">
      <tr>
        <td style="background:#E2483D; border-radius:14px 14px 0 0; padding:22px 28px;">
          <div style="font-family:Arial,Helvetica,sans-serif; font-size:12px; letter-spacing:1px; text-transform:uppercase; color:rgba(255,255,255,0.85); margin-bottom:6px;">⚠ Instant rank alert</div>
          <div style="font-family:Georgia,'Times New Roman',serif; font-size:20px; color:#ffffff; font-weight:bold;">${businessName} just ${changeText}.</div>
        </td>
      </tr>
      <tr>
        <td style="background:#ffffff; border-radius:0 0 14px 14px; padding:28px;">
          <p style="font-family:Arial,Helvetica,sans-serif; font-size:15px; color:#12212E; line-height:1.6; margin:0 0 20px;">
            We caught this the moment it happened instead of waiting for your next scheduled report — that's the whole point of Grow and Pro. Log in now to see who passed you and exactly what to fix.
          </p>
          <a href="${dashboardUrl}" style="display:inline-block; background:#E2483D; color:#ffffff; text-decoration:none; padding:12px 22px; border-radius:8px; font-family:Arial,Helvetica,sans-serif; font-weight:bold; font-size:14px;">See what happened →</a>
        </td>
      </tr>
    </table>
  </div>
  `;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL || 'RankHighPro <onboarding@resend.dev>',
      to,
      subject: `⚠ Instant alert: ${businessName} just lost ranking`,
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
          const email = (session.customer_email || session.customer_details?.email || '').trim().toLowerCase();
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
          const customerResult = await pool.query(
            `SELECT * FROM customers WHERE stripe_customer_id = $1`,
            [sub.customer]
          );
          await pool.query(
            `UPDATE customers SET status = 'canceled' WHERE stripe_customer_id = $1`,
            [sub.customer]
          );
          console.log('Subscription canceled for Stripe customer:', sub.customer);
          if (customerResult.rows.length > 0) {
            const listingsResult = await pool.query(
              `SELECT DISTINCT business_category, location FROM tracked_listings
               WHERE customer_id = $1 AND business_category IS NOT NULL`,
              [customerResult.rows[0].id]
            );
            for (const l of listingsResult.rows) {
              await notifyWaitlistIfSpotOpen(l.business_category, l.location);
            }
          }
          break;
        }
        case 'invoice.payment_failed': {
          const invoice = event.data.object;
          const customerResult = await pool.query(
            `SELECT * FROM customers WHERE stripe_customer_id = $1`,
            [invoice.customer]
          );
          await pool.query(
            `UPDATE customers SET status = 'past_due' WHERE stripe_customer_id = $1`,
            [invoice.customer]
          );
          console.log('Payment failed for Stripe customer:', invoice.customer);
          if (customerResult.rows.length > 0) {
            const listingsResult = await pool.query(
              `SELECT DISTINCT business_category, location FROM tracked_listings
               WHERE customer_id = $1 AND business_category IS NOT NULL`,
              [customerResult.rows[0].id]
            );
            for (const l of listingsResult.rows) {
              await notifyWaitlistIfSpotOpen(l.business_category, l.location);
            }
          }
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
app.use(express.json({ limit: '10mb' }));
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
// HEALTH SCORE (all tiers)
// A single 0-100 number that summarizes how a listing is doing right now.
// This is NOT a new ranking factor — it's a psychological progress/retention
// tool built entirely from data RankHighPro already collects on its normal
// schedule. No extra API calls, no extra cost, computed fresh every time the
// dashboard loads.
//
// Weighted out of 100:
//   - Local pack position ............ 30 pts
//   - Google Business Profile health .. 20 pts (fewer active issues = higher)
//   - Website AI-readiness ............ 15 pts (schema + keyword in title/meta)
//   - Reviews (volume + rating) ....... 15 pts
//   - AI answer-engine visibility ..... 20 pts (of 5 platforms checked)
// ---------------------------------------------------------------------------
function computeHealthScore(latestCheck, latestAiCheck, hasWebsiteUrl) {
  if (!latestCheck) return null; // no check has run yet — nothing to score

  const raw = latestCheck.raw || {};
  const allFindings = raw.allFindings || [];
  const websiteCheck = raw.websiteCheck || null;

  // 1. Local pack position (30 pts) — linear falloff, 0 if not in the pack.
  const position = latestCheck.local_pack_position;
  const positionScore = position == null ? 0 : Math.max(0, Math.round(30 - (position - 1) * 3));

  // 2. GBP profile health (20 pts) — start full, dock points per active
  // issue. Website-related findings are excluded here since they're scored
  // separately below, so nothing is double-counted.
  const websiteFindingTypes = ['missing_schema', 'keyword_missing_title', 'keyword_missing_meta'];
  const gbpFindings = allFindings.filter((f) => !websiteFindingTypes.includes(f.type));
  let gbpScore = 20;
  for (const f of gbpFindings) {
    gbpScore -= f.severity === 'error' ? 6 : 3;
  }
  gbpScore = Math.max(0, gbpScore);

  // 3. Website AI-readiness (15 pts) — no website on file scores 0 here,
  // since there's nothing yet for AI crawlers to read.
  let websiteScore = 0;
  if (websiteCheck && websiteCheck.found) {
    websiteScore =
      (websiteCheck.hasLocalBusinessSchema ? 7 : 0) +
      (websiteCheck.hasKeywordInTitle ? 4 : 0) +
      (websiteCheck.hasKeywordInMeta ? 4 : 0);
  }

  // 4. Reviews (15 pts) — volume capped at 10pts (50+ reviews), rating
  // scaled from 3.0 (0pts) to 5.0 (5pts).
  const reviewCount = latestCheck.review_count || 0;
  const rating = latestCheck.rating;
  const reviewCountScore = Math.min(10, Math.floor(reviewCount / 5));
  const ratingScore = rating ? Math.max(0, Math.min(5, (rating - 3) * 2.5)) : 0;
  const reviewScore = Math.round(reviewCountScore + ratingScore);

  // 5. AI answer-engine visibility (20 pts) — share of the 5 platforms
  // that mentioned this business in the most recent check.
  let aiScore = 0;
  if (latestAiCheck) {
    const platforms = ['chatgpt', 'perplexity', 'gemini', 'grok', 'claude'];
    const mentionedCount = platforms.filter((p) => latestAiCheck[`${p}_mentioned`] === true).length;
    aiScore = Math.round((mentionedCount / platforms.length) * 20);
  }

  const total = Math.max(0, Math.min(100, positionScore + gbpScore + websiteScore + reviewScore + aiScore));

  // A short, honest note on the single biggest thing dragging the score
  // down right now — not a full report, just enough to point at what to
  // fix next.
  const buckets = [
    { label: 'local ranking position', score: positionScore, max: 30 },
    { label: 'Google Business Profile issues', score: gbpScore, max: 20 },
    { label: 'website AI-readiness', score: websiteScore, max: 15 },
    { label: 'review volume/rating', score: reviewScore, max: 15 },
    { label: 'AI answer-engine visibility', score: aiScore, max: 20 },
  ];
  const weakest = buckets.reduce((worst, b) => ((b.max - b.score) > (worst.max - worst.score) ? b : worst));
  const weakestArea = (weakest.max - weakest.score) > 0 ? weakest.label : null;

  return { score: total, weakestArea, breakdown: buckets };
}

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
      const aiCheckResult = await pool.query(
        `SELECT * FROM ai_visibility_checks WHERE tracked_listing_id = $1 ORDER BY checked_at DESC LIMIT 1`,
        [listing.id]
      );
      const healthScore = computeHealthScore(
        historyResult.rows[0] || null,
        aiCheckResult.rows[0] || null,
        !!listing.website_url
      );
      listings.push({ ...listing, history: historyResult.rows, healthScore });
    }

    res.json({ customer, listings });
  } catch (err) {
    console.error('dashboard error:', err.message);
    res.status(500).json({ error: 'Could not load dashboard' });
  }
});

// ---------------------------------------------------------------------------
// LOCAL EXCLUSIVITY (Grow, Pro & Fully Managed By Us only)
// On Watch, direct local competitors can all sign up — no restriction. On
// Grow, Pro, and Fully Managed By Us, we only allow ONE business per
// business_category per local area (matched on category + "City, State"
// location, both case-insensitive). The same business_category in a
// DIFFERENT area is always fine on any tier — this only blocks local,
// same-category overlap on the paid-exclusivity tiers.
// ---------------------------------------------------------------------------
async function isLocalSpotTaken(businessCategory, location, excludeCustomerId) {
  const params = [businessCategory.trim(), location.trim()];
  let query = `
    SELECT tl.business_name FROM tracked_listings tl
    JOIN customers c ON c.id = tl.customer_id
    WHERE c.status = 'active'
      AND c.plan IN ('grow', 'managed', 'fullservice')
      AND LOWER(tl.business_category) = LOWER($1)
      AND LOWER(tl.location) = LOWER($2)
  `;
  if (excludeCustomerId) {
    params.push(excludeCustomerId);
    query += ` AND c.id != $3`;
  }
  query += ' LIMIT 1';

  const result = await pool.query(query, params);
  return result.rows.length > 0;
}

async function checkExclusivity(customerId, businessCategory, location) {
  if (!businessCategory || !businessCategory.trim()) {
    return { allowed: true }; // no category given — nothing to check against
  }

  const taken = await isLocalSpotTaken(businessCategory, location, customerId);
  if (taken) {
    return {
      allowed: false,
      error: `This is exclusive — a ${businessCategory.trim()} business in ${location.trim()} already holds this spot on Grow, Pro, or Fully Managed By Us, which means no local competitor of the same type can join RankHighPro at all right now, on any plan. Join the waitlist and we'll email and text you the moment a spot opens up.`,
    };
  }

  return { allowed: true };
}

// Sends a text message via Twilio. Silently skips (with a log line) if
// Twilio isn't configured yet — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
// and TWILIO_PHONE_NUMBER in Railway to enable this.
async function sendSms(to, message) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
    console.warn('Twilio not configured — SMS not sent. Would have sent to:', to, '| Message:', message);
    return;
  }
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const body = new URLSearchParams({ From: process.env.TWILIO_PHONE_NUMBER, To: to, Body: message });

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    }
  );
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    console.error('Twilio SMS send failed:', data.message || response.status);
  }
}

async function sendWaitlistConfirmationEmail({ to, businessName, businessCategory, location }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — waitlist confirmation not emailed. Would have sent to:', to);
    return;
  }
  const html = `
    <p>Hi there,</p>
    <p>You're on the waitlist for the exclusive Grow/Pro spot for <strong>${businessCategory}</strong> businesses in <strong>${location}</strong>.</p>
    <p>The moment that spot opens up, we'll email <em>and</em> text you immediately so you can grab it before anyone else on the list.</p>
    <p>Thanks for your patience,<br>RankHighPro</p>
  `;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL || 'RankHighPro <onboarding@resend.dev>',
      to,
      subject: `You're on the waitlist — ${businessName}`,
      html,
    }),
  });
}

async function sendWaitlistSpotOpenEmail({ to, businessName, businessCategory, location }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — spot-open alert not emailed. Would have sent to:', to);
    return;
  }
  const html = `
  <div style="background:#F6F1E4; padding:32px 16px; font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" style="max-width:560px; margin:0 auto; border-collapse:collapse;">
      <tr>
        <td style="background:#4FAE7A; border-radius:14px 14px 0 0; padding:22px 28px;">
          <div style="font-family:Arial,Helvetica,sans-serif; font-size:12px; letter-spacing:1px; text-transform:uppercase; color:rgba(255,255,255,0.9); margin-bottom:6px;">A spot just opened</div>
          <div style="font-family:Georgia,'Times New Roman',serif; font-size:20px; color:#ffffff; font-weight:bold;">The exclusive spot for ${businessCategory} in ${location} is open.</div>
        </td>
      </tr>
      <tr>
        <td style="background:#ffffff; border-radius:0 0 14px 14px; padding:28px;">
          <p style="font-family:Arial,Helvetica,sans-serif; font-size:15px; color:#12212E; line-height:1.6; margin:0 0 20px;">
            You're first in line, ${businessName}. Head back and sign up for Grow or Pro now to lock it in — it's first-come, first-served, so don't wait too long.
          </p>
          <a href="${FRONTEND_URL}/#pricing" style="display:inline-block; background:#E2483D; color:#ffffff; text-decoration:none; padding:12px 22px; border-radius:8px; font-family:Arial,Helvetica,sans-serif; font-weight:bold; font-size:14px;">Claim your spot →</a>
        </td>
      </tr>
    </table>
  </div>
  `;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL || 'RankHighPro <onboarding@resend.dev>',
      to,
      subject: `A spot just opened up — ${businessCategory} in ${location}`,
      html,
    }),
  });
}

// Checks whether a category+location spot is now open, and if so, notifies
// (email + text) the oldest still-waiting entry for it. Called whenever a
// Grow/Pro customer's status leaves 'active' or they remove the
// listing that was holding their exclusive spot.
async function notifyWaitlistIfSpotOpen(businessCategory, location) {
  if (!businessCategory || !location) return;
  try {
    const taken = await isLocalSpotTaken(businessCategory, location, null);
    if (taken) return; // someone else already holds it, or it was never actually free

    const result = await pool.query(
      `SELECT * FROM waitlist_entries
       WHERE status = 'waiting' AND LOWER(business_category) = LOWER($1) AND LOWER(location) = LOWER($2)
       ORDER BY created_at ASC LIMIT 1`,
      [businessCategory, location]
    );
    if (result.rows.length === 0) return;

    const entry = result.rows[0];
    await sendWaitlistSpotOpenEmail({
      to: entry.email,
      businessName: entry.business_name,
      businessCategory: entry.business_category,
      location: entry.location,
    });
    if (entry.phone) {
      await sendSms(
        entry.phone,
        `RankHighPro: A spot just opened for ${entry.business_category} in ${entry.location}! Sign up now at ${FRONTEND_URL}/#pricing — it's first-come, first-served.`
      );
    }
    await pool.query(`UPDATE waitlist_entries SET status = 'notified', notified_at = now() WHERE id = $1`, [entry.id]);
    console.log(`Notified waitlist entry ${entry.id} that a spot opened for ${businessCategory} in ${location}`);
  } catch (err) {
    console.error('notifyWaitlistIfSpotOpen error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// GET /api/exclusivity-check?category=...&location=...&plan=...
// Public — used BEFORE checkout so nobody pays for a Grow/Pro spot that
// isn't actually available. Watch is always available.
// ---------------------------------------------------------------------------
app.get('/api/exclusivity-check', async (req, res) => {
  try {
    const { category, location, plan } = req.query;
    if (!category || !location || !plan) {
      return res.status(400).json({ error: 'Missing category, location, or plan' });
    }
    // Exclusivity now applies to every tier: if a Grow/Pro competitor
    // already holds this category+area, Watch is blocked too. A
    // Watch-only competitor never blocks anything.
    const taken = await isLocalSpotTaken(category, location, null);
    res.json({ available: !taken });
  } catch (err) {
    console.error('exclusivity-check error:', err.message);
    res.status(500).json({ error: 'Could not check availability' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/waitlist
// Body: { email, phone, businessName, businessCategory, location, plan }
// Public — lets someone join the waitlist when their local exclusivity
// spot is already taken, instead of being turned away outright.
// ---------------------------------------------------------------------------
app.post('/api/waitlist', async (req, res) => {
  try {
    const { email, phone, businessName, businessCategory, location, plan } = req.body;
    if (!email || !email.includes('@') || !businessName || !businessCategory || !location || !plan) {
      return res.status(400).json({ error: 'email, businessName, businessCategory, location, and plan are all required' });
    }

    const result = await pool.query(
      `INSERT INTO waitlist_entries (email, phone, business_name, business_category, location, plan_interested)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [email.trim().toLowerCase(), phone ? phone.trim() : null, businessName.trim(), businessCategory.trim(), location.trim(), plan]
    );

    try {
      await sendWaitlistConfirmationEmail({ to: email, businessName, businessCategory, location });
    } catch (emailErr) {
      console.error('waitlist confirmation email failed:', emailErr.message);
    }

    res.json({ entry: result.rows[0] });
  } catch (err) {
    console.error('join waitlist error:', err.message);
    res.status(500).json({ error: 'Could not join the waitlist' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/tracked-listings   (auth required)
// Body: { businessName, websiteUrl, location, keyword, businessCategory }
// ---------------------------------------------------------------------------
app.post('/api/tracked-listings', requireAuth, async (req, res) => {
  try {
    const { businessName, websiteUrl, location, keyword, businessCategory, reviewLink } = req.body;
    if (!businessName || !location || !keyword) {
      return res.status(400).json({ error: 'businessName, location, and keyword are required' });
    }

    const { plan } = await getCustomerPlanStatus(req.customer.id);
    // Exclusivity applies to every tier now: if a Grow/Pro competitor
    // already holds this category+area, nobody else — Watch included —
    // can add a competing listing here. Watch-only areas stay open.
    const exclusivity = await checkExclusivity(req.customer.id, businessCategory, location);
    if (!exclusivity.allowed) {
      return res.status(409).json({ error: exclusivity.error });
    }

    // If they pasted their Google review link right at signup, extract the
    // place ID immediately so accurate checks start from the very first
    // one — same logic used when saving/updating the link later.
    const placeId = reviewLink ? extractPlaceIdFromReviewLink(reviewLink) : null;

    const result = await pool.query(
      `INSERT INTO tracked_listings (customer_id, business_name, website_url, location, keyword, business_category, review_link, google_place_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.customer.id, businessName, websiteUrl || null, location, keyword, businessCategory || null, reviewLink || null, placeId]
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
      `DELETE FROM tracked_listings WHERE id = $1 AND customer_id = $2 RETURNING id, business_category, location`,
      [req.params.id, req.customer.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    const deleted = result.rows[0];
    if (deleted.business_category) {
      notifyWaitlistIfSpotOpen(deleted.business_category, deleted.location); // fire and forget
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error('delete tracked-listing error:', err.message);
    res.status(500).json({ error: 'Could not delete listing' });
  }
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// extractPlaceIdFromReviewLink(url)
// Google review links look like:
//   https://search.google.com/local/writereview?placeid=ChIJ...
// The placeid value is a stable, unique ID for that exact Google Business
// Profile — pulling it out lets us match the business exactly on future
// checks instead of matching by name text, which can misfire on naming
// variations or duplicate listings.
// ---------------------------------------------------------------------------
function extractPlaceIdFromReviewLink(url) {
  if (!url) return null;
  const match = url.match(/[?&]placeid=([^&]+)/i);
  return match ? decodeURIComponent(match[1]) : null;
}

// ---------------------------------------------------------------------------
// PATCH /api/tracked-listings/:id/review-link   (auth required)
// Body: { reviewLink }
// Lets a customer set/update the direct Google review link for one of their
// tracked listings. Once this is set, review requests can be sent for it.
// We also extract the Google place ID from this link automatically (see
// extractPlaceIdFromReviewLink above) to make future rank/audit checks more
// accurate — no separate field or instructions needed from the customer.
// ---------------------------------------------------------------------------
app.patch('/api/tracked-listings/:id/review-link', requireAuth, async (req, res) => {
  try {
    const { reviewLink } = req.body;
    if (!reviewLink || !reviewLink.startsWith('http')) {
      return res.status(400).json({ error: 'A valid reviewLink URL is required' });
    }

    const placeId = extractPlaceIdFromReviewLink(reviewLink);

    const result = await pool.query(
      `UPDATE tracked_listings SET review_link = $1, google_place_id = COALESCE($2, google_place_id)
       WHERE id = $3 AND customer_id = $4 RETURNING *`,
      [reviewLink, placeId, req.params.id, req.customer.id]
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
// PATCH /api/tracked-listings/:id/social-links   (auth required)
// Body: { facebookUrl, instagramUrl, xUrl } — any subset of these. Lets a
// customer link their own social media profiles to a tracked listing.
// Available on every subscription tier (not gated). Empty string clears a
// field; a non-empty value must start with http.
// ---------------------------------------------------------------------------
app.patch('/api/tracked-listings/:id/social-links', requireAuth, async (req, res) => {
  try {
    const { facebookUrl, instagramUrl, xUrl } = req.body;

    for (const [label, value] of [['facebookUrl', facebookUrl], ['instagramUrl', instagramUrl], ['xUrl', xUrl]]) {
      if (value && value.trim() !== '' && !value.startsWith('http')) {
        return res.status(400).json({ error: `${label} must be a valid link starting with http, or left blank.` });
      }
    }

    const listingResult = await pool.query(
      `SELECT * FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.id, req.customer.id]
    );
    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    const existing = listingResult.rows[0];

    const nextFacebook = facebookUrl !== undefined ? (facebookUrl.trim() || null) : existing.facebook_url;
    const nextInstagram = instagramUrl !== undefined ? (instagramUrl.trim() || null) : existing.instagram_url;
    const nextX = xUrl !== undefined ? (xUrl.trim() || null) : existing.x_url;

    const result = await pool.query(
      `UPDATE tracked_listings SET facebook_url = $1, instagram_url = $2, x_url = $3
       WHERE id = $4 AND customer_id = $5 RETURNING *`,
      [nextFacebook, nextInstagram, nextX, req.params.id, req.customer.id]
    );
    res.json({ listing: result.rows[0] });
  } catch (err) {
    console.error('set social-links error:', err.message);
    res.status(500).json({ error: 'Could not save social media links' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/tracked-listings/:id/website-builder   (auth required)
// Body: { websiteBuilder: "wordpress" | "wix" | "squarespace" | "shopify" | "custom" }
// Saves which platform this listing's website is built on, so the schema
// check only ever shows THAT platform's paste-in instructions instead of
// dumping all five at once.
// ---------------------------------------------------------------------------
const VALID_WEBSITE_BUILDERS = ['wordpress', 'wix', 'squarespace', 'shopify', 'custom'];
app.patch('/api/tracked-listings/:id/website-builder', requireAuth, async (req, res) => {
  try {
    const { websiteBuilder } = req.body;
    if (!VALID_WEBSITE_BUILDERS.includes(websiteBuilder)) {
      return res.status(400).json({ error: 'Unknown website builder: ' + websiteBuilder });
    }

    const result = await pool.query(
      `UPDATE tracked_listings SET website_builder = $1
       WHERE id = $2 AND customer_id = $3 RETURNING *`,
      [websiteBuilder, req.params.id, req.customer.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    res.json({ listing: result.rows[0] });
  } catch (err) {
    console.error('set website-builder error:', err.message);
    res.status(500).json({ error: 'Could not save your website builder' });
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

    const quota = await checkFeatureAllowed(req.customer.id, 'reviewRequests');
    if (!quota.allowed) {
      return res.status(403).json({ error: quota.error });
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
  managed: { name: 'RankHighPro Pro', amountCents: 39900 },
  fullservice: { name: 'RankHighPro Fully Managed By Us', amountCents: 60000 },
};

// ---------------------------------------------------------------------------
// DISPLAY NAMES
// Customer-facing tier names shown in the dashboard, emails, and checkout.
// Kept separate from the internal plan key (used in every DB query, feature
// gate, and Stripe metadata field below) so a marketing rename never
// requires touching the plan-logic plumbing. If you rename a tier again,
// change it here only.
// ---------------------------------------------------------------------------
const TIER_DISPLAY_NAMES = {
  watch: 'Watch',
  grow: 'Grow',
  managed: 'Pro',
  fullservice: 'Fully Managed By Us',
};

// ---------------------------------------------------------------------------
// TIER LIMITS
// Monthly caps per subscription tier. `null` means unlimited.
//   - aiContentPerMonth: shared pool covering BOTH Facebook/Instagram ads
//     AND X posts combined (generating either one counts against the same
//     monthly total).
//   - gbpPostsPerMonth: Google Business Profile posts.
//   - reviewRequestsPerMonth: review-request emails created.
// A customer whose plan isn't recognized (shouldn't normally happen) falls
// back to the Watch limits as the safest default.
// ---------------------------------------------------------------------------
const TIER_LIMITS = {
  watch:       { aiContentPerMonth: 2,    gbpPostsPerMonth: 4,    reviewRequestsPerMonth: null, supportChatPerMonth: 40,  extraKeywordsLimit: 0 },
  grow:        { aiContentPerMonth: 6,    gbpPostsPerMonth: null, reviewRequestsPerMonth: null, supportChatPerMonth: 100, extraKeywordsLimit: 3 },
  managed:     { aiContentPerMonth: null, gbpPostsPerMonth: null, reviewRequestsPerMonth: null, supportChatPerMonth: null, extraKeywordsLimit: 5 },
  // Fully Managed By Us customers don't touch these self-serve tools
  // directly (the dashboard hides them entirely — see the stripped-down
  // view keyed on plan === 'fullservice'), so limits here are moot, but
  // kept unlimited/null for safety in case any shared code path checks them.
  fullservice: { aiContentPerMonth: null, gbpPostsPerMonth: null, reviewRequestsPerMonth: null, supportChatPerMonth: null, extraKeywordsLimit: 5 },
};

// Looks up a customer's current plan + subscription status.
async function getCustomerPlanStatus(customerId) {
  const result = await pool.query(`SELECT plan, status FROM customers WHERE id = $1`, [customerId]);
  return result.rows[0] || { plan: null, status: 'inactive' };
}

// Counts rows matching a query — used for all the "how many has this
// customer used this calendar month" checks below.
async function countRows(query, params) {
  const result = await pool.query(query, params);
  return parseInt(result.rows[0].count, 10);
}

// Confirms the logged-in customer has an active subscription and has not
// hit the given monthly limit for a feature. Returns { allowed: true } or
// { allowed: false, error: '...' } — never throws, so callers can just
// check `.allowed` and respond.
async function checkFeatureAllowed(customerId, feature) {
  const { plan, status } = await getCustomerPlanStatus(customerId);

  if (status !== 'active') {
    return {
      allowed: false,
      error: 'Your RankHighPro subscription is not active. Please subscribe or update your billing to use this feature.',
    };
  }

  const limits = TIER_LIMITS[plan] || TIER_LIMITS.watch;

  if (feature === 'aiContent') {
    if (limits.aiContentPerMonth === null) return { allowed: true };
    const adCount = await countRows(
      `SELECT COUNT(*) FROM social_ads sa
       JOIN tracked_listings tl ON tl.id = sa.tracked_listing_id
       WHERE tl.customer_id = $1 AND sa.created_at >= date_trunc('month', now())`,
      [customerId]
    );
    const xCount = await countRows(
      `SELECT COUNT(*) FROM x_posts xp
       JOIN tracked_listings tl ON tl.id = xp.tracked_listing_id
       WHERE tl.customer_id = $1 AND xp.created_at >= date_trunc('month', now())`,
      [customerId]
    );
    const used = adCount + xCount;
    if (used >= limits.aiContentPerMonth) {
      return {
        allowed: false,
        error: `You've used all ${limits.aiContentPerMonth} AI ad/post generation${limits.aiContentPerMonth === 1 ? '' : 's'} included in your ${plan} plan this month. Upgrade your plan for more.`,
      };
    }
    return { allowed: true };
  }

  if (feature === 'gbpPosts') {
    if (limits.gbpPostsPerMonth === null) return { allowed: true };
    const used = await countRows(
      `SELECT COUNT(*) FROM gbp_posts gp
       JOIN tracked_listings tl ON tl.id = gp.tracked_listing_id
       WHERE tl.customer_id = $1 AND gp.created_at >= date_trunc('month', now())`,
      [customerId]
    );
    if (used >= limits.gbpPostsPerMonth) {
      return {
        allowed: false,
        error: `You've used all ${limits.gbpPostsPerMonth} GBP post${limits.gbpPostsPerMonth === 1 ? '' : 's'} included in your ${plan} plan this month. Upgrade your plan for more.`,
      };
    }
    return { allowed: true };
  }

  if (feature === 'reviewRequests') {
    if (limits.reviewRequestsPerMonth === null) return { allowed: true };
    const used = await countRows(
      `SELECT COUNT(*) FROM review_requests
       WHERE customer_id = $1 AND created_at >= date_trunc('month', now())`,
      [customerId]
    );
    if (used >= limits.reviewRequestsPerMonth) {
      return {
        allowed: false,
        error: `You've used all ${limits.reviewRequestsPerMonth} review request${limits.reviewRequestsPerMonth === 1 ? '' : 's'} included in your ${plan} plan this month. Upgrade your plan for more.`,
      };
    }
    return { allowed: true };
  }

  if (feature === 'supportChat') {
    if (limits.supportChatPerMonth === null) return { allowed: true };
    const used = await countRows(
      `SELECT COUNT(*) FROM support_chat_messages
       WHERE customer_id = $1 AND created_at >= date_trunc('month', now())`,
      [customerId]
    );
    if (used >= limits.supportChatPerMonth) {
      return {
        allowed: false,
        error: `You've used all ${limits.supportChatPerMonth} AI assistant messages included in your ${plan} plan this month. Upgrade your plan for more.`,
      };
    }
    return { allowed: true };
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// POST /api/create-checkout-session
// Body: { plan: "watch" | "grow" | "managed" | "fullservice", email }
// Email is now required so we can tie the Stripe subscription to a customer
// account (used by the webhook above to activate their dashboard access).
// Note: "managed" is the Pro tier and "fullservice" is
// Fully Managed By Us — those are the customer-facing display names only
// (see TIER_DISPLAY_NAMES); the plan key stays the same in Stripe/DB.
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
      allow_promotion_codes: true,
      // Fully Managed By Us is white-glove, hands-on work on our end from
      // day one — no free trial on that tier. Every other tier keeps the
      // standard 7-day trial.
      subscription_data: plan === 'fullservice' ? {} : {
        trial_period_days: 7,
      },
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
//
// Tries Google Local Finder first — this captures the FULL expanded list
// (up to 20 businesses on desktop), the same list a real customer sees
// after clicking "More places." Without this, a business ranking 4th or
// lower would incorrectly show as "not in local pack" even when it's
// genuinely visible there, just not in the initial 3-business preview.
// Falls back to the classic 3-pack (embedded in a normal organic search)
// only if the Local Finder call fails for some reason.
// ---------------------------------------------------------------------------
async function runRankCheck(keyword, location, businessName, placeId) {
  const auth = Buffer.from(
    `${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`
  ).toString('base64');

  // DataForSEO's location_name needs the full "City,State,Country" format
  // to reliably resolve — without the country appended, it can fail to
  // match a specific location and come back with no local pack at all,
  // even for a business that's genuinely ranking. Same normalization used
  // in runGbpAudit and fetchAndDraftReviewReplies, now applied here too.
  let fullLocation = location.trim().replace(/\s*,\s*/g, ',');
  const commaCount = (fullLocation.match(/,/g) || []).length;
  if (commaCount === 1) fullLocation = fullLocation + ',United States';

  function findPosition(items) {
    if (placeId) {
      const idx = items.findIndex((i) => i.place_id === placeId || i.cid === placeId);
      if (idx !== -1) return idx + 1;
    }
    if (businessName) {
      const idx = items.findIndex((i) =>
        (i.title || '').toLowerCase().includes(businessName.toLowerCase())
      );
      if (idx !== -1) return idx + 1;
    }
    return null;
  }

  // --- Try Local Finder first (up to 20 results on desktop) ---
  try {
    const lfResponse = await fetch(
      'https://api.dataforseo.com/v3/serp/google/local_finder/live/advanced',
      {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ keyword, location_name: fullLocation, language_code: 'en', device: 'desktop' }]),
      }
    );
    const lfData = await lfResponse.json();
    const lfItems = lfData?.tasks?.[0]?.result?.[0]?.items || [];

    if (lfItems.length > 0) {
      return { localPackItems: lfItems, position: findPosition(lfItems), raw: lfData, source: 'local_finder' };
    }
  } catch (lfErr) {
    console.error('Local Finder check failed, falling back to classic 3-pack:', lfErr.message);
  }

  // --- Fallback: classic 3-pack embedded in a normal organic search ---
  const response = await fetch(
    'https://api.dataforseo.com/v3/serp/google/organic/live/advanced',
    {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ keyword, location_name: fullLocation, language_code: 'en', device: 'mobile' }]),
    }
  );

  const data = await response.json();
  const items = data?.tasks?.[0]?.result?.[0]?.items || [];
  const localPack = items.find((i) => i.type === 'local_pack');
  const localPackItems = localPack ? localPack.items : [];

  return { localPackItems, position: findPosition(localPackItems), raw: data, source: 'organic_fallback' };
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
async function runGbpAudit(business, location, placeId) {
  let fullLocation = location.trim().replace(/\s*,\s*/g, ',');
  const commaCount = (fullLocation.match(/,/g) || []).length;
  if (commaCount === 1) fullLocation = fullLocation + ',United States';

  const auth = Buffer.from(
    `${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`
  ).toString('base64');

  // When we have this business's exact Google place ID (extracted from
  // their review link — see extractPlaceIdFromReviewLink), use it directly
  // instead of a name search. DataForSEO supports this via a special
  // "place_id:XXXX" keyword value, and it guarantees we're looking at
  // THIS exact listing — no risk of a naming mismatch or duplicate-listing
  // mix-up pulling in the wrong business's reviews/rating.
  const searchKeyword = placeId ? `place_id:${placeId}` : business;

  const response = await fetch(
    'https://api.dataforseo.com/v3/business_data/google/my_business_info/live',
    {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ keyword: searchKeyword, location_name: fullLocation, language_code: 'en' }]),
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
    findings.push({ severity: 'error', type: 'low_reviews', message: `Only ${reviewCount} reviews found. Businesses ranking in the map pack for competitive terms often have 100+.` });
  } else if (reviewCount < 100) {
    findings.push({ severity: 'warn', type: 'low_reviews', message: `${reviewCount} reviews found — solid, but top-ranking competitors likely have more.` });
  }
  if (rating !== null && rating < 4.3) {
    findings.push({ severity: 'warn', type: 'low_rating', message: `Average rating is ${rating} — ratings below 4.3 can quietly hurt click-through in the map pack.` });
  }

  const premiumFindings = [];
  if (isVerified === false) premiumFindings.push({ severity: 'error', type: 'unclaimed', message: 'This listing does not appear to be verified/claimed. Unclaimed listings rank significantly worse.' });
  if (!hasPhotos) premiumFindings.push({ severity: 'warn', type: 'no_photos', message: 'No photos found on this listing. Listings with regular photo activity tend to rank and convert better.' });
  if (categories.length === 0) premiumFindings.push({ severity: 'error', type: 'no_category', message: 'No business category found.' });
  else if (categories.length === 1) premiumFindings.push({ severity: 'warn', type: 'single_category', message: 'Only one business category listed.' });
  if (!hasWorkHours) premiumFindings.push({ severity: 'warn', type: 'no_hours', message: 'No business hours listed.' });
  if (!phone) premiumFindings.push({ severity: 'error', type: 'no_phone', message: 'No phone number found on this listing.' });
  if (!website) premiumFindings.push({ severity: 'warn', type: 'no_website', message: 'No website link found on this listing.' });
  if (!description || description.trim().length < 50) premiumFindings.push({ severity: 'warn', type: 'short_description', message: 'Business description is missing or very short.' });

  return { found: true, fullLocation, rating, reviewCount, findings, premiumFindings, phone, website };
}

// ---------------------------------------------------------------------------
// fetchAndDraftReviewReplies(listing)
// Pulls the most recent ~20 Google reviews for a listing via DataForSEO's
// Reviews API (priority queue — ~1 min turnaround, ~$0.003 per call at 20
// reviews), then generates an AI-drafted reply for any review we haven't
// seen before (matched on DataForSEO's own review_id, so nothing gets
// re-drafted on the next check). Reviews already in review_replies are
// skipped entirely — no re-fetch cost avoidance is possible on the
// DataForSEO side (it always returns the recent batch), but we never call
// Claude twice for the same review.
// Returns the number of NEW replies drafted this run.
// ---------------------------------------------------------------------------
async function fetchAndDraftReviewReplies(listing) {
  const auth = Buffer.from(
    `${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`
  ).toString('base64');

  let fullLocation = listing.location.trim().replace(/\s*,\s*/g, ',');
  const commaCount = (fullLocation.match(/,/g) || []).length;
  if (commaCount === 1) fullLocation = fullLocation + ',United States';

  // 1. Post the task (priority queue, so it's ready within ~1 minute —
  // safe to poll for within this same background job run). Uses the exact
  // Google place ID when we have one (extracted from the customer's review
  // link) so this pulls reviews for THIS exact listing, not a name-matched
  // guess.
  const postResponse = await fetch(
    'https://api.dataforseo.com/v3/business_data/google/reviews/task_post',
    {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        keyword: listing.google_place_id ? `place_id:${listing.google_place_id}` : listing.business_name,
        location_name: fullLocation,
        language_code: 'en',
        depth: 20,
        priority: 2, // priority queue
      }]),
    }
  );
  const postData = await postResponse.json();
  const taskId = postData?.tasks?.[0]?.id;
  if (!taskId) {
    console.error('review-replies: no task ID returned', JSON.stringify(postData).slice(0, 300));
    return 0;
  }

  // 2. Poll for the result — priority queue is typically ready within a
  // minute. Try a handful of times with a short delay between attempts.
  let items = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise((r) => setTimeout(r, 8000));
    const getResponse = await fetch(
      `https://api.dataforseo.com/v3/business_data/google/reviews/task_get/${taskId}`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    const getData = await getResponse.json();
    const task = getData?.tasks?.[0];
    if (task?.status_code === 20000 && task?.result?.[0]?.items) {
      items = task.result[0].items;
      break;
    }
  }
  if (!items) {
    console.error(`review-replies: task ${taskId} never completed in time for listing ${listing.id}`);
    return 0;
  }

  let newCount = 0;
  for (const review of items) {
    if (!review.review_id || !review.review_text) continue;

    // Skip if we've already stored this exact review.
    const existing = await pool.query(
      `SELECT id FROM review_replies WHERE tracked_listing_id = $1 AND review_id = $2`,
      [listing.id, review.review_id]
    );
    if (existing.rows.length > 0) continue;

    const rating = review.rating?.value ? Math.round(review.rating.value) : null;
    const reviewerName = review.profile_name || review.reviewer?.name || 'a customer';

    let aiDraftReply = null;
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const tone = rating !== null && rating <= 3
          ? 'This is a critical or mixed review. Write a calm, professional, non-defensive reply: thank them for the feedback, briefly acknowledge the concern without being an admission of fault, and invite them to reach out directly to make it right. Do not sound scripted or corporate.'
          : 'This is a positive review. Write a warm, genuine, specific thank-you reply — reference something from their review if possible. Keep it short and human, not generic.';

        const prompt = `Business name: ${listing.business_name}
Reviewer: ${reviewerName}
Star rating: ${rating ?? 'not given'}
Review text: "${review.review_text}"

Write a reply this business owner can post publicly on Google in response to this review. ${tone} Keep it under 60 words. No preamble, no quotation marks around the reply — output only the reply text itself.`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 200,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        const data = await response.json();
        aiDraftReply = data?.content?.map((b) => b.text || '').join(' ').trim() || null;
      } catch (aiErr) {
        console.error('review-replies: Claude draft failed:', aiErr.message);
      }
    }

    await pool.query(
      `INSERT INTO review_replies (tracked_listing_id, review_id, reviewer_name, rating, review_text, review_time, ai_draft_reply)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tracked_listing_id, review_id) DO NOTHING`,
      [listing.id, review.review_id, reviewerName, rating, review.review_text, review.timestamp || null, aiDraftReply]
    );
    newCount++;
  }

  return newCount;
}

// ---------------------------------------------------------------------------
// FIX INSTRUCTIONS LIBRARY
// Detailed, step-by-step "how to actually fix this" text for every finding
// type above, plus the website-check finding types added below. Watch and
// Grow customers see these directly in their report and dashboard. Pro
// customers get the same detection, but the fix itself (where automatable)
// gets escalated to the RankHighPro team instead of left as a checklist —
// see queueManagedAutoFix() further down.
// ---------------------------------------------------------------------------
const FIX_INSTRUCTIONS = {
  low_reviews: `1. Open your RankHighPro dashboard and use the "Request a review" tool under your listing.
2. Send a request to your last 15-20 customers this week — Google weights recent review velocity heavily, so a burst of new reviews moves your ranking faster than the same number spread over months.
3. Make it a habit: ask every customer at the point of sale, and send a request the same day.
4. Aim for at least 5 new reviews every month going forward, not just a one-time push.`,
  low_rating: `1. Respond to every negative review publicly and professionally within 48 hours — Google and customers both notice active management.
2. If a review breaks Google's policies (spam, unrelated to your business, posted by a non-customer), flag it for removal: open the review in your Google Business Profile, tap the three-dot menu, and select "Flag as inappropriate."
3. Focus on delivering a great experience to your next 10-15 customers and asking each one for a review — new positive reviews are the fastest way to recover your average.`,
  unclaimed: `1. Go to google.com/business and search for your business name.
2. If it shows as unclaimed, click "Claim this listing" and follow Google's verification steps — usually a postcard mailed to your business address, or instant verification by phone/email if you're eligible.
3. Until this is claimed, you can't edit anything else on this list — this is the first fix to make.`,
  no_photos: `1. Log into your Google Business Profile and go to the "Photos" tab.
2. Upload at least 10 real photos this week — your storefront (if you have one), your products, your team, and any behind-the-scenes shots.
3. Add a few new photos every month going forward — listings with regular new photo activity get a measurable ranking and click-through boost over static ones.`,
  no_category: `1. Open your Google Business Profile and go to Business Information > Category.
2. Add a primary category that's the single most accurate description of what your business IS (not just something you offer).
3. Add 2-4 secondary categories for other real parts of your business — don't add categories that don't genuinely apply, since Google penalizes mismatches.`,
  single_category: `1. Open your Google Business Profile and go to Business Information > Category.
2. Add 2-4 secondary categories that genuinely describe additional parts of your business, alongside your existing primary category.
3. Type each option into the category box and use only the exact matches Google suggests — don't force in anything that doesn't truly apply.`,
  no_hours: `1. Open your Google Business Profile and go to Business Information > Hours.
2. Add your accurate, current operating hours for every day of the week.
3. This is one of the fastest fixes available — it takes about 60 seconds and removes a real, active ranking penalty.`,
  no_phone: `1. Open your Google Business Profile and go to Business Information > Contact.
2. Add a working phone number that actually reaches your business.
3. This is one of the most basic trust signals Google checks — a missing phone number actively hurts your ranking, not just your customers' ability to reach you.`,
  no_website: `1. Open your Google Business Profile and go to Business Information > Contact.
2. Add your website URL.
3. If you don't have a website yet, even a single simple page is better than none for this purpose — it's a real ranking signal Google checks for.`,
  short_description: `1. Open your Google Business Profile and go to Business Information > About > Description.
2. Write a genuine 150+ word description of your business — what you offer, your location, and what makes you worth choosing. Write it naturally for a real customer, not stuffed with keywords.
3. Save it, and revisit it every few months to keep it accurate as your business changes.`,
  missing_schema: `1. Copy the code snippet provided in your dashboard's schema check.
2. See the "How do I add this to my website?" instructions right below the snippet for exact steps based on your website platform (WordPress, Wix, Squarespace, Shopify, or custom HTML).
3. Paste the snippet in, save, and re-run the schema check in your dashboard to confirm it's now detected.`,
  keyword_missing_title: `1. Open your website's homepage editor (see platform-specific steps in your dashboard).
2. Find your page's Title/SEO Title field.
3. Rewrite it to naturally include your tracked keyword — for example: "[Your Business Name] | [Keyword] in [Your City]".
4. Save and republish your page.`,
  keyword_missing_meta: `1. Open your website's homepage editor (see platform-specific steps in your dashboard).
2. Find the Meta Description / SEO Description field.
3. Write a natural 1-2 sentence description that includes your tracked keyword and what makes your business worth choosing.
4. Save and republish your page.`,
};

// ---------------------------------------------------------------------------
// SCHEMA MARKUP CHECK
// Fetches a business's live website HTML and looks for LocalBusiness (or a
// subtype) JSON-LD structured data. If it's missing, we generate a ready
// -to-paste snippet filled in with whatever info we already have on file.
// ---------------------------------------------------------------------------
async function checkSchemaMarkup(websiteUrl, keyword) {
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

    // Keyword-in-title / keyword-in-meta-description checks — a simple,
    // real on-page SEO signal we can check without any special access.
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const pageTitle = titleMatch ? titleMatch[1].trim() : '';
    const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
    const metaDescription = metaMatch ? metaMatch[1].trim() : '';

    const keywordLower = (keyword || '').toLowerCase().trim();
    const hasKeywordInTitle = keywordLower ? pageTitle.toLowerCase().includes(keywordLower) : true;
    const hasKeywordInMeta = keywordLower ? metaDescription.toLowerCase().includes(keywordLower) : true;

    return { found: true, hasLocalBusinessSchema, foundTypes, pageTitle, metaDescription, hasKeywordInTitle, hasKeywordInMeta };
  } catch (err) {
    console.error('Schema markup check failed:', err.message);
    return { found: false, error: err.message };
  }
}

// Step-by-step instructions for pasting the schema snippet and editing
// title/meta tags, broken out by common website platform. Shown as an
// expandable "how do I actually do this" block alongside the fix.
function generateWebsiteFixSteps() {
  return {
    wordpress: `WordPress:
1. In your WordPress dashboard, go to Appearance > Theme File Editor, OR install a free plugin like "Insert Headers and Footers."
2. If using the plugin: go to Settings > Insert Headers and Footers, paste the code into the "Scripts in Header" box, and save.
3. To edit your title/meta description: if you use Yoast SEO or RankMath, edit them directly on your homepage's edit screen under the SEO section.`,
    wix: `Wix:
1. Go to your Wix Editor, then Settings > Custom Code (or Advanced > Custom Code).
2. Click "Add Custom Code," paste the snippet, set it to load on your homepage, in the <head> section, and save.
3. To edit your title/meta description: go to your homepage's SEO settings (the gear/SEO icon on that page) and update the SEO Title and Description fields directly.`,
    squarespace: `Squarespace:
1. Go to Settings > Advanced > Code Injection.
2. Paste the snippet into the "Header" box and save.
3. To edit your title/meta description: go to Pages, click the gear icon on your homepage, and update the SEO Title and Description fields under the SEO tab.`,
    shopify: `Shopify:
1. Go to Online Store > Themes > Edit Code.
2. Open theme.liquid, find the </head> tag, and paste the snippet directly above it. Save.
3. To edit your title/meta description: go to Online Store > Preferences and update the homepage title and meta description fields.`,
    custom: `Custom HTML / other platform:
1. Open your website's HTML file (or ask whoever manages your hosting).
2. Paste the snippet directly before the closing </head> tag.
3. To edit your title/meta description: find the <title> tag and the <meta name="description"> tag near the top of the file and update the text inside them directly.`,
  };
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
// CREDENTIAL ENCRYPTION
// Used only for storing WordPress Application Passwords — encrypted at
// rest with AES-256-GCM. Requires CREDENTIAL_ENCRYPTION_KEY to be set in
// Railway; if it's missing, credential storage is refused outright rather
// than silently falling back to storing anything in plain text.
// ---------------------------------------------------------------------------
function getEncryptionKey() {
  const secret = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!secret) return null;
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptSecret(plainText) {
  const key = getEncryptionKey();
  if (!key) throw new Error('CREDENTIAL_ENCRYPTION_KEY is not configured on the server.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decryptSecret(encoded) {
  const key = getEncryptionKey();
  if (!key) throw new Error('CREDENTIAL_ENCRYPTION_KEY is not configured on the server.');
  const data = Buffer.from(encoded, 'base64');
  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// POST /api/wordpress/:listingId/connect   (auth required, Pro only)
// Body: { siteUrl, username, applicationPassword }
// Tests the connection with a real API call before saving anything.
// ---------------------------------------------------------------------------
app.post('/api/wordpress/:listingId/connect', requireAuth, async (req, res) => {
  try {
    const { siteUrl, username, applicationPassword } = req.body;
    if (!siteUrl || !username || !applicationPassword) {
      return res.status(400).json({ error: 'siteUrl, username, and applicationPassword are all required' });
    }

    const listingResult = await pool.query(
      `SELECT tl.*, c.plan FROM tracked_listings tl JOIN customers c ON c.id = tl.customer_id WHERE tl.id = $1 AND tl.customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });
    if (listingResult.rows[0].plan !== 'managed') {
      return res.status(403).json({ error: 'WordPress auto-fix connection is a Pro-tier feature.' });
    }

    let normalizedUrl = siteUrl.trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) normalizedUrl = `https://${normalizedUrl}`;
    normalizedUrl = normalizedUrl.replace(/\/$/, '');

    const testAuth = Buffer.from(`${username}:${applicationPassword}`).toString('base64');
    const testResponse = await fetch(`${normalizedUrl}/wp-json/wp/v2/users/me`, {
      headers: { Authorization: `Basic ${testAuth}` },
    });
    if (!testResponse.ok) {
      return res.status(400).json({ error: 'Could not connect with those details. Double check your site URL, username, and application password.' });
    }

    let encryptedPassword;
    try {
      encryptedPassword = encryptSecret(applicationPassword);
    } catch (encErr) {
      return res.status(500).json({ error: 'Server is not configured to store credentials securely yet. Contact support.' });
    }

    await pool.query(`DELETE FROM wordpress_connections WHERE tracked_listing_id = $1`, [req.params.listingId]);
    const result = await pool.query(
      `INSERT INTO wordpress_connections (tracked_listing_id, site_url, wp_username, wp_app_password)
       VALUES ($1, $2, $3, $4) RETURNING id, site_url, wp_username, status, connected_at`,
      [req.params.listingId, normalizedUrl, username, encryptedPassword]
    );

    res.json({ connection: result.rows[0] });
  } catch (err) {
    console.error('wordpress connect error:', err.message);
    res.status(500).json({ error: 'Could not connect to WordPress.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/wordpress/:listingId/status   (auth required)
// ---------------------------------------------------------------------------
app.get('/api/wordpress/:listingId/status', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(`SELECT id FROM tracked_listings WHERE id = $1 AND customer_id = $2`, [req.params.listingId, req.customer.id]);
    if (listingResult.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });

    const result = await pool.query(
      `SELECT id, site_url, wp_username, status, connected_at FROM wordpress_connections WHERE tracked_listing_id = $1`,
      [req.params.listingId]
    );
    res.json({ connection: result.rows[0] || null });
  } catch (err) {
    console.error('wordpress status error:', err.message);
    res.status(500).json({ error: 'Could not load connection status' });
  }
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Multi-provider AI Assistant chat helpers.
// Each function takes (systemPrompt, history, userMessage, image,
// imageMediaType) and returns { reply, error }. History arrives in the same
// {role: 'user'|'assistant', content}[] shape the frontend already sends for
// Claude — each helper adapts that shape to what its own API expects.
// Image support: Claude, ChatGPT, and Gemini can see screenshots. Perplexity
// and Grok get the text only, with a short note added so the assistant
// doesn't silently ignore an attached image.
// ---------------------------------------------------------------------------

function buildUserContent(message, image, imageMediaType, supportsVision) {
  const text = message && message.trim() ? message.trim() : 'Here is a screenshot — please help me with what you see.';
  if (image && supportsVision) {
    return { text, image, imageMediaType };
  }
  if (image && !supportsVision) {
    return { text: text + '\n\n[The customer attached a screenshot, but this AI model cannot view images — ask them to describe what they see instead.]' };
  }
  return { text };
}

async function chatWithClaude(systemPrompt, history, message, image, imageMediaType) {
  if (!process.env.ANTHROPIC_API_KEY) return { error: 'ANTHROPIC_API_KEY is not configured.' };
  const built = buildUserContent(message, image, imageMediaType, true);
  const userContent = built.image
    ? [
        { type: 'image', source: { type: 'base64', media_type: built.imageMediaType || 'image/jpeg', data: built.image } },
        { type: 'text', text: built.text },
      ]
    : built.text;

  const messages = [...history, { role: 'user', content: userContent }].slice(-20);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 600, system: systemPrompt, messages }),
  });
  const data = await response.json();
  const reply = data?.content?.map((b) => b.text || '').join(' ').trim();
  return reply ? { reply } : { error: 'No reply from Claude.' };
}

async function chatWithOpenAiCompatible(baseUrl, apiKey, model, systemPrompt, history, message, image, imageMediaType, supportsVision) {
  if (!apiKey) return { error: 'API key not configured for this model.' };
  const built = buildUserContent(message, image, imageMediaType, supportsVision);
  const userContent = built.image
    ? [
        { type: 'text', text: built.text },
        { type: 'image_url', image_url: { url: `data:${built.imageMediaType || 'image/jpeg'};base64,${built.image}` } },
      ]
    : built.text;

  // History items from the frontend are plain {role, content} strings (no
  // images in past turns are re-sent — only the current message can carry
  // one), so they pass through unchanged here.
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userContent },
  ].slice(-21); // system + last 20

  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages }),
  });
  const data = await response.json();
  const reply = data?.choices?.[0]?.message?.content?.trim();
  return reply ? { reply } : { error: data?.error?.message || 'No reply from this model.' };
}

async function chatWithGemini(systemPrompt, history, message, image, imageMediaType) {
  if (!process.env.GEMINI_API_KEY) return { error: 'GEMINI_API_KEY is not configured.' };
  const built = buildUserContent(message, image, imageMediaType, true);

  const geminiHistory = history.map((h) => ({
    role: h.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof h.content === 'string' ? h.content : JSON.stringify(h.content) }],
  }));

  const userParts = [{ text: built.text }];
  if (built.image) {
    userParts.push({ inlineData: { mimeType: built.imageMediaType || 'image/jpeg', data: built.image } });
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [...geminiHistory, { role: 'user', parts: userParts }],
      }),
    }
  );
  const data = await response.json();
  const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  return reply ? { reply } : { error: data?.error?.message || 'No reply from Gemini.' };
}

const AI_PROVIDERS = {
  claude: { label: 'Claude', run: (sys, hist, msg, img, mt) => chatWithClaude(sys, hist, msg, img, mt) },
  chatgpt: { label: 'ChatGPT', run: (sys, hist, msg, img, mt) => chatWithOpenAiCompatible('https://api.openai.com/v1/chat/completions', process.env.OPENAI_API_KEY, 'gpt-4o-mini', sys, hist, msg, img, mt, true) },
  gemini: { label: 'Gemini', run: (sys, hist, msg, img, mt) => chatWithGemini(sys, hist, msg, img, mt) },
  perplexity: { label: 'Perplexity', run: (sys, hist, msg, img, mt) => chatWithOpenAiCompatible('https://api.perplexity.ai/chat/completions', process.env.PERPLEXITY_API_KEY, 'sonar', sys, hist, msg, img, mt, false) },
  grok: { label: 'Grok', run: (sys, hist, msg, img, mt) => chatWithOpenAiCompatible('https://api.x.ai/v1/chat/completions', process.env.XAI_API_KEY, 'grok-4.6', sys, hist, msg, img, mt, false) },
};

// POST /api/support-chat   (auth required, all tiers)
// Body: { message, history, image, imageMediaType, provider }
// A general-purpose AI assistant for customers to ask anything about
// their listing, local SEO, or how to use RankHighPro. Available on every
// tier. `provider` picks which of the 5 major AI models answers —
// defaults to Claude if omitted or unrecognized.
// ---------------------------------------------------------------------------
app.post('/api/support-chat', requireAuth, async (req, res) => {
  try {
    const { message, history, image, imageMediaType, provider, marketingContext } = req.body;
    if ((!message || !message.trim()) && !image) {
      return res.status(400).json({ error: 'Message or screenshot is required' });
    }

    const { plan, status } = await getCustomerPlanStatus(req.customer.id);
    if (status !== 'active') {
      return res.status(403).json({ error: 'Your subscription is not active.' });
    }

    // "Let's Market Your Business" platform chats are a Grow+ upsell —
    // Watch customers get a locked teaser in the UI, and this blocks the
    // API directly too, not just the button.
    if (marketingContext && plan === 'watch') {
      return res.status(403).json({ error: 'Marketing help for other platforms is available on Grow and above.' });
    }

    const quota = await checkFeatureAllowed(req.customer.id, 'supportChat');
    if (!quota.allowed) {
      return res.status(403).json({ error: quota.error });
    }

    const selected = AI_PROVIDERS[provider] || AI_PROVIDERS.claude;

    // MARKETING_PLATFORM_CONTEXTS: when this chat lives inside one of the
    // "Let's Market Your Business" platform panels, marketingContext names
    // which one (e.g. "facebook"), and this swaps in a specialist system
    // prompt focused on THIS customer's own business marketing on that one
    // platform — a different job than the general RankHighPro dashboard
    // assistant used everywhere else.
    const MARKETING_PLATFORM_CONTEXTS = {
      google: 'Google Ads (Search campaigns) and Google Local Services Ads',
      facebook: 'Facebook (Meta Ads Manager, Lead Ads, Business Manager, and organic Facebook group strategy)',
      instagram: 'Instagram (Reels, Stories, hashtags, and Meta Ads Manager placements)',
      x: 'X (formerly Twitter) — organic threads/posts and X Ads',
      nextdoor: 'Nextdoor — business pages and local neighborhood ads',
      linkedin: 'LinkedIn — organic posting and LinkedIn Ads',
      tiktok: 'TikTok — organic short-form video and TikTok Ads (Spark Ads)',
      youtube: 'YouTube — organic tutorial-style video content and YouTube Ads via Google Ads',
      reddit: 'Reddit — organic community engagement and Reddit Ads',
    };

    const systemPrompt = marketingContext && MARKETING_PLATFORM_CONTEXTS[marketingContext]
      ? `You are a marketing specialist helping a small local business owner (${plan}-tier RankHighPro customer) market THEIR OWN business specifically on ${MARKETING_PLATFORM_CONTEXTS[marketingContext]}. They have zero marketing experience — explain everything in plain, jargon-free language, with exact tap-by-tap steps when describing how to use that platform's tools (assume they're on their phone). If they send a screenshot of that platform's app or website, look at it carefully and tell them exactly what to tap next based on what's actually shown. Stay focused on ${MARKETING_PLATFORM_CONTEXTS[marketingContext]} specifically — if they ask about a totally different platform, give a brief answer and suggest they use that platform's own chat box in the "Let's Market Your Business" section for deeper help there. Be warm, direct, and practical. Keep answers concise — this is a mobile chat interface.`
      : `You are the RankHighPro AI assistant, built into the customer's RankHighPro dashboard. RankHighPro is a local SEO platform that tracks Google Business Profile ranking, checks AI answer-engine visibility (ChatGPT, Gemini, Perplexity, Grok, Claude), generates AI content (Google Business posts, social ads, X posts), sends automated review requests, and helps customers connect their own Twilio account to run text message marketing campaigns. Help this ${plan}-tier customer with questions about their local SEO, their Google Business Profile, how to use RankHighPro's dashboard features (including Twilio/text campaign setup), and general small-business marketing advice. If they send a screenshot, look at it carefully and give specific guidance based on exactly what's shown — for Twilio screenshots, help them find the right button, field, or setting. Be warm, direct, and practical. If asked something outside local SEO, marketing, or RankHighPro's features, answer briefly and steer back to how you can help their ranking. Keep answers concise — this is a mobile chat interface.`;

    const cleanHistory = (Array.isArray(history) ? history : []).map((h) => ({ role: h.role, content: h.content }));

    const result = await selected.run(systemPrompt, cleanHistory, message, image, imageMediaType);
    if (result.error) {
      console.error(`support-chat (${provider || 'claude'}) error:`, result.error);
      return res.status(502).json({ error: `Could not reach ${selected.label} right now — please try again or switch models.` });
    }

    await pool.query(`INSERT INTO support_chat_messages (customer_id) VALUES ($1)`, [req.customer.id]);

    res.json({ reply: result.reply, provider: provider || 'claude' });
  } catch (err) {
    console.error('support-chat error:', err.message);
    res.status(500).json({ error: 'Could not reach the AI assistant.' });
  }
});

// ---------------------------------------------------------------------------
// DIRECT MESSAGING (all tiers)
// A message log so any customer can reach the RankHighPro team directly
// from their dashboard — questions, requests, or feature ideas. Every
// message a customer sends emails ADMIN_NOTIFY_EMAIL, and the admin inbox
// (admin.html) lists every plan's threads together.
// ---------------------------------------------------------------------------
app.post('/api/direct-message', requireAuth, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required.' });
    }

    const { status } = await getCustomerPlanStatus(req.customer.id);
    if (status !== 'active') {
      return res.status(403).json({ error: 'Your subscription is not active.' });
    }

    await pool.query(
      `INSERT INTO direct_messages (customer_id, sender, message) VALUES ($1, 'customer', $2)`,
      [req.customer.id, message.trim()]
    );

    if (process.env.ADMIN_NOTIFY_EMAIL && process.env.RESEND_API_KEY) {
      const customerResult = await pool.query(
        `SELECT email FROM customers WHERE id = $1`,
        [req.customer.id]
      );
      const customerEmail = customerResult.rows[0]?.email || 'unknown';

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.RESEND_FROM_EMAIL || 'RankHighPro <onboarding@resend.dev>',
          to: process.env.ADMIN_NOTIFY_EMAIL,
          subject: `New message from ${customerEmail}`,
          html: `<p><strong>Customer message</strong></p><p>From: ${customerEmail}</p><pre style="background:#f4f4f4; padding:12px; border-radius:6px; white-space:pre-wrap; font-size:13px;">${message.trim()}</pre>`,
        }),
      }).catch((err) => console.error('direct-message admin email error:', err.message));
    } else {
      console.warn('ADMIN_NOTIFY_EMAIL or RESEND_API_KEY not set — direct message saved but no email sent.');
    }

    res.json({ success: true });
  } catch (err) {
    console.error('direct-message error:', err.message);
    res.status(500).json({ error: 'Could not send your message. Please try again.' });
  }
});

app.get('/api/direct-messages', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sender, message, created_at FROM direct_messages
       WHERE customer_id = $1 ORDER BY created_at ASC LIMIT 200`,
      [req.customer.id]
    );
    res.json({ messages: result.rows });
  } catch (err) {
    console.error('direct-messages fetch error:', err.message);
    res.status(500).json({ error: 'Could not load messages.' });
  }
});

// ---------------------------------------------------------------------------
// REVIEW REPLIES (Grow & Pro) — list + dismiss
// ---------------------------------------------------------------------------
app.get('/api/review-replies/:listingId', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(
      `SELECT id FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    const result = await pool.query(
      `SELECT * FROM review_replies WHERE tracked_listing_id = $1 AND status != 'dismissed'
       ORDER BY created_at DESC LIMIT 20`,
      [req.params.listingId]
    );
    res.json({ replies: result.rows });
  } catch (err) {
    console.error('review-replies fetch error:', err.message);
    res.status(500).json({ error: 'Could not load review replies.' });
  }
});

app.patch('/api/review-replies/:id/dismiss', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE review_replies rr SET status = 'dismissed'
       FROM tracked_listings tl
       WHERE rr.id = $1 AND rr.tracked_listing_id = tl.id AND tl.customer_id = $2
       RETURNING rr.id`,
      [req.params.id, req.customer.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Review reply not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('review-reply dismiss error:', err.message);
    res.status(500).json({ error: 'Could not update this review reply.' });
  }
});

// ---------------------------------------------------------------------------
// BACKLINK OPPORTUNITIES (Pro exclusive)
// ---------------------------------------------------------------------------
app.get('/api/backlink-opportunities/:listingId', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(
      `SELECT id FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    const { plan } = await getCustomerPlanStatus(req.customer.id);
    if (plan !== 'managed') {
      return res.status(403).json({ error: 'Backlink-building assistance is available on the Pro plan.' });
    }

    const result = await pool.query(
      `SELECT * FROM backlink_opportunities WHERE tracked_listing_id = $1 AND status != 'dismissed'
       ORDER BY created_at ASC`,
      [req.params.listingId]
    );
    res.json({ opportunities: result.rows });
  } catch (err) {
    console.error('backlink-opportunities fetch error:', err.message);
    res.status(500).json({ error: 'Could not load backlink opportunities.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/backlink-opportunities/:listingId/generate   (auth, Pro only)
// Body: { force: boolean }
// Generates a personalized list of realistic backlink opportunities for
// this specific business via Claude — no third-party API, so this costs
// only a few cents in Claude tokens, generated once and cached (like the
// AI visibility game plan) unless force:true is sent.
// ---------------------------------------------------------------------------
app.post('/api/backlink-opportunities/:listingId/generate', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(
      `SELECT * FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    const listing = listingResult.rows[0];

    const { plan } = await getCustomerPlanStatus(req.customer.id);
    if (plan !== 'managed') {
      return res.status(403).json({ error: 'Backlink-building assistance is available on the Pro plan.' });
    }

    const existing = await pool.query(
      `SELECT id FROM backlink_opportunities WHERE tracked_listing_id = $1`,
      [req.params.listingId]
    );
    if (existing.rows.length > 0 && !req.body.force) {
      const opportunities = await pool.query(
        `SELECT * FROM backlink_opportunities WHERE tracked_listing_id = $1 AND status != 'dismissed' ORDER BY created_at ASC`,
        [req.params.listingId]
      );
      return res.json({ opportunities: opportunities.rows, cached: true });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'The AI assistant is not configured right now.' });
    }

    const prompt = `A local business needs realistic backlink opportunities — real places on the web that might link back to their website, which is one of the strongest local SEO ranking factors there is.

Business name: ${listing.business_name}
Business type: ${listing.business_category || listing.keyword}
Location: ${listing.location}
Website: ${listing.website_url || 'not on file'}

Generate exactly 6 realistic, specific backlink opportunities for THIS business in THIS city — not generic advice. Think: the local Chamber of Commerce, a neighborhood association, a local news site or blog that covers small businesses, a complementary local business that could cross-link (e.g. a supplier, a referral partner, a nearby business owners' group), a community sponsorship opportunity (a local youth sports team, a charity event), and one realistic "guest content" opportunity relevant to their industry.

For each one, respond with EXACTLY this format, one block per opportunity, separated by "---":

NAME: [specific name of the opportunity — a real org type, not a placeholder]
TYPE: [one of: directory, local-media, partner-business, sponsorship, guest-content, community-org]
WHY: [1 sentence on why this specific one is worth pursuing for this business]
HOW_TO_CONTACT: [1-2 sentences telling someone with no marketing experience exactly how to find this organization's contact info — what to search on Google, which page on their likely website to check (e.g. "look for a Contact or About page"), or that they likely have a Facebook page with a Message button. Be concrete and practical, not vague.]
TEMPLATE: [a short, ready-to-send outreach message, 60-90 words, personalized to this business, that they can copy and paste into an email or contact form, or read over the phone — friendly and specific, not generic corporate language, ending with a clear, simple ask]

No preamble, no numbering, no extra commentary — just the 6 blocks separated by "---".`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1800,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await response.json();
    const text = data?.content?.map((b) => b.text || '').join(' ').trim();
    if (!text) {
      return res.status(502).json({ error: 'Could not generate backlink opportunities right now — please try again.' });
    }

    const blocks = text.split('---').map((b) => b.trim()).filter(Boolean);
    const parsed = [];
    for (const block of blocks) {
      const name = block.match(/NAME:\s*(.+)/)?.[1]?.trim();
      const type = block.match(/TYPE:\s*(.+)/)?.[1]?.trim();
      const why = block.match(/WHY:\s*(.+)/)?.[1]?.trim();
      const howToContact = block.match(/HOW_TO_CONTACT:\s*(.+)/)?.[1]?.trim();
      const templateMatch = block.match(/TEMPLATE:\s*([\s\S]+)/);
      const template = templateMatch?.[1]?.trim();
      if (name && template) {
        parsed.push({ name, type: type || 'other', why: why || '', howToContact: howToContact || '', template });
      }
    }

    if (parsed.length === 0) {
      return res.status(502).json({ error: 'Could not parse the generated opportunities — please try again.' });
    }

    if (req.body.force) {
      await pool.query(`DELETE FROM backlink_opportunities WHERE tracked_listing_id = $1`, [req.params.listingId]);
    }

    for (const opp of parsed) {
      await pool.query(
        `INSERT INTO backlink_opportunities (tracked_listing_id, opportunity_name, opportunity_type, why_it_helps, how_to_contact, outreach_template)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [req.params.listingId, opp.name, opp.type, opp.why, opp.howToContact, opp.template]
      );
    }

    const finalResult = await pool.query(
      `SELECT * FROM backlink_opportunities WHERE tracked_listing_id = $1 AND status != 'dismissed' ORDER BY created_at ASC`,
      [req.params.listingId]
    );
    res.json({ opportunities: finalResult.rows, cached: false });
  } catch (err) {
    console.error('backlink-opportunities generate error:', err.message);
    res.status(500).json({ error: 'Could not generate backlink opportunities right now.' });
  }
});

app.patch('/api/backlink-opportunities/:id/status', requireAuth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['new', 'contacted', 'completed', 'dismissed'].includes(status)) {
      return res.status(400).json({ error: 'Unknown status: ' + status });
    }
    const result = await pool.query(
      `UPDATE backlink_opportunities bo SET status = $1
       FROM tracked_listings tl
       WHERE bo.id = $2 AND bo.tracked_listing_id = tl.id AND tl.customer_id = $3
       RETURNING bo.id`,
      [status, req.params.id, req.customer.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Backlink opportunity not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('backlink-opportunity status update error:', err.message);
    res.status(500).json({ error: 'Could not update this opportunity.' });
  }
});

// ---------------------------------------------------------------------------
// BEAT THIS COMPETITOR (Pro exclusive)
// ---------------------------------------------------------------------------
app.get('/api/beat-competitor/:listingId/candidates', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(
      `SELECT * FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    const listing = listingResult.rows[0];

    const { plan } = await getCustomerPlanStatus(req.customer.id);
    if (plan !== 'managed') {
      return res.status(403).json({ error: 'Beat This Competitor reports are available on the Pro plan.' });
    }

    const historyResult = await pool.query(
      `SELECT raw FROM rank_history WHERE tracked_listing_id = $1 ORDER BY checked_at DESC LIMIT 1`,
      [req.params.listingId]
    );
    if (historyResult.rows.length === 0) {
      return res.json({ candidates: [] });
    }

    const localPack = historyResult.rows[0].raw?.rank || [];
    const candidates = localPack
      .filter((c) => (c.title || '').toLowerCase() !== listing.business_name.toLowerCase())
      .map((c) => ({ name: c.title, position: c.position || c.rank_absolute || null }));

    res.json({ candidates });
  } catch (err) {
    console.error('beat-competitor candidates error:', err.message);
    res.status(500).json({ error: 'Could not load competitors.' });
  }
});

app.get('/api/beat-competitor/:listingId/reports', requireAuth, async (req, res) => {
  try {
    const { plan } = await getCustomerPlanStatus(req.customer.id);
    if (plan !== 'managed') {
      return res.status(403).json({ error: 'Beat This Competitor reports are available on the Pro plan.' });
    }
    const result = await pool.query(
      `SELECT * FROM competitor_reports WHERE tracked_listing_id = $1 ORDER BY created_at DESC`,
      [req.params.listingId]
    );
    res.json({ reports: result.rows });
  } catch (err) {
    console.error('beat-competitor reports fetch error:', err.message);
    res.status(500).json({ error: 'Could not load reports.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/beat-competitor/:listingId/generate   (auth, Pro only)
// Body: { competitorName, force }
// Pulls a fresh GBP snapshot on the chosen competitor (one internal audit
// call, ~$0.0015 — the same call used everywhere else in the app), then
// has Claude write a concrete, side-by-side plan to pass them specifically.
// Cached per (listing, competitor) — repeat requests return instantly
// unless force:true.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// generateAndCacheCompetitorReport(listing, myLatest, competitorName, competitorPosition, competitorReviewCount, competitorRating, force)
// Shared by both the manual "pick a competitor" endpoint and the automatic
// "Top 3 To Beat" endpoint. Checks the cache first (per listing+competitor),
// otherwise calls Claude to write a numbers-based plan and caches it.
// ---------------------------------------------------------------------------
async function generateAndCacheCompetitorReport(listing, myLatest, competitorName, competitorPosition, competitorReviewCount, competitorRating, force) {
  const existing = await pool.query(
    `SELECT * FROM competitor_reports WHERE tracked_listing_id = $1 AND competitor_name = $2`,
    [listing.id, competitorName.trim()]
  );
  if (existing.rows.length > 0 && !force) {
    return { report: existing.rows[0], cached: true };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('The AI assistant is not configured right now.');
  }

  const myWebsiteCheck = myLatest?.raw?.websiteCheck || null;
  const prompt = `A local business wants a concrete plan to pass one specific competitor in Google's local pack.

THEIR business: ${listing.business_name} (${listing.business_category || listing.keyword})
Location: ${listing.location}
Their current local pack position: ${myLatest?.local_pack_position ?? 'not currently in the pack'}
Their review count: ${myLatest?.review_count ?? 'unknown'}, rating: ${myLatest?.rating ?? 'unknown'}
Their website has schema markup: ${myWebsiteCheck?.hasLocalBusinessSchema ? 'yes' : 'no'}
Their website has the keyword in the title: ${myWebsiteCheck?.hasKeywordInTitle ? 'yes' : 'no'}

THE COMPETITOR: ${competitorName.trim()}
Competitor's local pack position: ${competitorPosition ?? 'unknown'}
Competitor's review count: ${competitorReviewCount ?? 'unknown'}, rating: ${competitorRating ?? 'unknown'}

Write a short, direct, prioritized plan (4-6 numbered steps) for exactly how THEIR business can pass THIS competitor specifically — not generic SEO advice. Reference the actual numbers above where you have them (e.g. "they have X more reviews than you — close that gap by..."). If a number is unknown for the competitor, don't guess it — just focus on what IS known. Ground every step in a real, legitimate local SEO lever (reviews, GBP completeness, website schema/content, citations, backlinks). No preamble — start directly with step 1. Keep each step to 1-2 sentences. Keep the whole thing under 180 words.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await response.json();
  const reportText = data?.content?.map((b) => b.text || '').join(' ').trim();
  if (!reportText) {
    throw new Error('Could not generate a report right now — please try again.');
  }

  const upserted = await pool.query(
    `INSERT INTO competitor_reports (tracked_listing_id, competitor_name, competitor_position, competitor_review_count, competitor_rating, report_text)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tracked_listing_id, competitor_name)
     DO UPDATE SET competitor_position = $3, competitor_review_count = $4, competitor_rating = $5, report_text = $6, created_at = now()
     RETURNING *`,
    [listing.id, competitorName.trim(), competitorPosition, competitorReviewCount, competitorRating, reportText]
  );

  return { report: upserted.rows[0], cached: false };
}

// ---------------------------------------------------------------------------
// GET /api/beat-competitor/:listingId/top3   (auth, Pro only)
// Automatically shows the top 3 competitors currently ranking above this
// listing, each with a plan to pass them — no manual picking needed. Uses
// the competitor snapshot already collected on the last scheduled check
// (competitorDetails), so this costs nothing extra beyond the Claude call
// for any competitor that hasn't been reported on yet.
// ---------------------------------------------------------------------------
app.get('/api/beat-competitor/:listingId/top3', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(
      `SELECT * FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    const listing = listingResult.rows[0];

    const { plan } = await getCustomerPlanStatus(req.customer.id);
    if (plan !== 'managed') {
      return res.status(403).json({ error: 'Beat This Competitor reports are available on the Pro plan.' });
    }

    const historyResult = await pool.query(
      `SELECT * FROM rank_history WHERE tracked_listing_id = $1 ORDER BY checked_at DESC LIMIT 1`,
      [req.params.listingId]
    );
    const myLatest = historyResult.rows[0] || null;
    const competitorDetails = myLatest?.raw?.competitorDetails || [];
    const localPack = myLatest?.raw?.rank || [];

    if (competitorDetails.length === 0) {
      return res.json({ reports: [], noDataReason: !myLatest ? 'no_check_yet' : 'not_in_pack' });
    }

    const reports = [];
    for (const comp of competitorDetails.slice(0, 3)) {
      const packEntry = localPack.find((c) => (c.title || '').toLowerCase() === comp.name.toLowerCase());
      const competitorPosition = packEntry?.position || packEntry?.rank_absolute || null;
      try {
        const { report } = await generateAndCacheCompetitorReport(
          listing, myLatest, comp.name, competitorPosition, comp.reviewCount, comp.rating, false
        );
        reports.push(report);
      } catch (genErr) {
        console.error(`top3 report generation failed for "${comp.name}":`, genErr.message);
      }
    }

    res.json({ reports });
  } catch (err) {
    console.error('beat-competitor top3 error:', err.message);
    res.status(500).json({ error: 'Could not load your top competitors.' });
  }
});

app.post('/api/beat-competitor/:listingId/generate', requireAuth, async (req, res) => {
  try {
    const { competitorName, force } = req.body;
    if (!competitorName || !competitorName.trim()) {
      return res.status(400).json({ error: 'A competitor name is required.' });
    }

    const listingResult = await pool.query(
      `SELECT * FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    const listing = listingResult.rows[0];

    const { plan } = await getCustomerPlanStatus(req.customer.id);
    if (plan !== 'managed') {
      return res.status(403).json({ error: 'Beat This Competitor reports are available on the Pro plan.' });
    }

    const historyResult = await pool.query(
      `SELECT * FROM rank_history WHERE tracked_listing_id = $1 ORDER BY checked_at DESC LIMIT 1`,
      [req.params.listingId]
    );
    const myLatest = historyResult.rows[0] || null;
    const localPack = myLatest?.raw?.rank || [];
    const competitorEntry = localPack.find(
      (c) => (c.title || '').toLowerCase() === competitorName.trim().toLowerCase()
    );
    const competitorPosition = competitorEntry?.position || competitorEntry?.rank_absolute || null;

    // Fresh GBP snapshot on the competitor — same cheap internal audit
    // call used for the customer's own listing, just pointed at them.
    // (The automatic Top 3 endpoint skips this and reuses the snapshot
    // already taken during the scheduled check, since it's cheaper.)
    let compAudit = { found: false };
    try {
      compAudit = await runGbpAudit(competitorName.trim(), listing.location);
    } catch (auditErr) {
      console.error('beat-competitor audit error:', auditErr.message);
    }

    const { report, cached } = await generateAndCacheCompetitorReport(
      listing, myLatest, competitorName,
      competitorPosition,
      compAudit.found ? compAudit.reviewCount : null,
      compAudit.found ? compAudit.rating : null,
      force
    );

    res.json({ report, cached });
  } catch (err) {
    console.error('beat-competitor generate error:', err.message);
    res.status(500).json({ error: err.message || 'Could not generate this report right now.' });
  }
});

// ---------------------------------------------------------------------------
// KEYWORD SUGGESTIONS (all tiers)
// ---------------------------------------------------------------------------
app.get('/api/keyword-suggestions/:listingId', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(
      `SELECT id FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    const result = await pool.query(
      `SELECT * FROM keyword_suggestions WHERE tracked_listing_id = $1 AND status != 'dismissed'
       ORDER BY created_at ASC`,
      [req.params.listingId]
    );
    res.json({ suggestions: result.rows });
  } catch (err) {
    console.error('keyword-suggestions fetch error:', err.message);
    res.status(500).json({ error: 'Could not load keyword suggestions.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/keyword-suggestions/:listingId/generate   (auth, all tiers)
// Body: { force }
// Generates realistic alternate/additional keyword ideas for this specific
// business — each paired with the concrete change needed to have a real
// shot at ranking for it. Pure Claude call, no third-party API, generated
// once and cached unless force:true.
// ---------------------------------------------------------------------------
app.post('/api/keyword-suggestions/:listingId/generate', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(
      `SELECT * FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    const listing = listingResult.rows[0];

    const existing = await pool.query(
      `SELECT id FROM keyword_suggestions WHERE tracked_listing_id = $1`,
      [req.params.listingId]
    );
    if (existing.rows.length > 0 && !req.body.force) {
      const suggestions = await pool.query(
        `SELECT * FROM keyword_suggestions WHERE tracked_listing_id = $1 AND status != 'dismissed' ORDER BY created_at ASC`,
        [req.params.listingId]
      );
      return res.json({ suggestions: suggestions.rows, cached: true });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'The AI assistant is not configured right now.' });
    }

    const prompt = `A local business wants realistic keyword ideas that could bring them more customers through Google — beyond the one keyword they're currently tracking.

Business name: ${listing.business_name}
Business type: ${listing.business_category || 'unknown'}
Location: ${listing.location}
Currently tracked keyword: "${listing.keyword}"
Website: ${listing.website_url || 'not on file'}

Generate exactly 5 realistic, specific keyword ideas someone in ${listing.location} might actually type into Google when looking for this kind of business — real search phrases, not generic industry terms. Vary them: include a couple of close variations of their current keyword, and a couple that target a different angle (a specific service they likely offer, an urgency/quality angle like "same day" or "licensed", or a nearby neighborhood).

For each one, respond with EXACTLY this format, one block per keyword, separated by "---":

KEYWORD: [the exact search phrase]
WHY: [1 sentence on why this phrase could bring in real customers]
TITLE_TAG: [a realistic website page title, under 60 characters, that includes this keyword naturally]
META_DESCRIPTION: [a realistic meta description, under 155 characters, that includes this keyword naturally]
GBP_CATEGORY: [a real, valid Google Business Profile category name relevant to this keyword — or "no change needed" if their existing category already covers it]
GBP_DESCRIPTION_TIP: [1 short sentence on how to naturally work this keyword into their GBP business description]

No preamble, no numbering, no extra commentary — just the 5 blocks separated by "---".`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1800,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await response.json();
    const text = data?.content?.map((b) => b.text || '').join(' ').trim();
    if (!text) {
      return res.status(502).json({ error: 'Could not generate keyword suggestions right now — please try again.' });
    }

    const blocks = text.split('---').map((b) => b.trim()).filter(Boolean);
    const parsed = [];
    for (const block of blocks) {
      const keyword = block.match(/KEYWORD:\s*(.+)/)?.[1]?.trim();
      const why = block.match(/WHY:\s*(.+)/)?.[1]?.trim();
      const titleTag = block.match(/TITLE_TAG:\s*(.+)/)?.[1]?.trim();
      const metaDescription = block.match(/META_DESCRIPTION:\s*(.+)/)?.[1]?.trim();
      const gbpCategory = block.match(/GBP_CATEGORY:\s*(.+)/)?.[1]?.trim();
      const gbpDescriptionTip = block.match(/GBP_DESCRIPTION_TIP:\s*(.+)/)?.[1]?.trim();
      if (keyword) {
        parsed.push({ keyword, why, titleTag, metaDescription, gbpCategory, gbpDescriptionTip });
      }
    }

    if (parsed.length === 0) {
      return res.status(502).json({ error: 'Could not parse the generated suggestions — please try again.' });
    }

    if (req.body.force) {
      await pool.query(`DELETE FROM keyword_suggestions WHERE tracked_listing_id = $1`, [req.params.listingId]);
    }

    for (const s of parsed) {
      await pool.query(
        `INSERT INTO keyword_suggestions (tracked_listing_id, keyword, why_it_helps, title_tag_suggestion, meta_description_suggestion, gbp_category_suggestion, gbp_description_suggestion)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [req.params.listingId, s.keyword, s.why, s.titleTag, s.metaDescription, s.gbpCategory, s.gbpDescriptionTip]
      );
    }

    const finalResult = await pool.query(
      `SELECT * FROM keyword_suggestions WHERE tracked_listing_id = $1 AND status != 'dismissed' ORDER BY created_at ASC`,
      [req.params.listingId]
    );
    res.json({ suggestions: finalResult.rows, cached: false });
  } catch (err) {
    console.error('keyword-suggestions generate error:', err.message);
    res.status(500).json({ error: 'Could not generate keyword suggestions right now.' });
  }
});

app.patch('/api/keyword-suggestions/:id/dismiss', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE keyword_suggestions ks SET status = 'dismissed'
       FROM tracked_listings tl
       WHERE ks.id = $1 AND ks.tracked_listing_id = tl.id AND tl.customer_id = $2
       RETURNING ks.id`,
      [req.params.id, req.customer.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Keyword suggestion not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('keyword-suggestion dismiss error:', err.message);
    res.status(500).json({ error: 'Could not update this suggestion.' });
  }
});

// ---------------------------------------------------------------------------
// TRACKED KEYWORDS (extra keywords beyond a listing's primary one)
// ---------------------------------------------------------------------------
app.get('/api/tracked-listings/:id/keywords', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(
      `SELECT id FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.id, req.customer.id]
    );
    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    const result = await pool.query(
      `SELECT * FROM tracked_keywords WHERE tracked_listing_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json({ keywords: result.rows });
  } catch (err) {
    console.error('tracked-keywords fetch error:', err.message);
    res.status(500).json({ error: 'Could not load tracked keywords.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/tracked-listings/:id/keywords   (auth required)
// Body: { keyword }
// Adds an extra keyword to track for this listing, on top of its primary
// one. Tier-limited (TIER_LIMITS.extraKeywordsLimit) since each tracked
// keyword adds a real ongoing DataForSEO cost on every scheduled check.
// Runs an immediate check so the customer sees a position right away
// instead of waiting for the next scheduled cycle.
// ---------------------------------------------------------------------------
app.post('/api/tracked-listings/:id/keywords', requireAuth, async (req, res) => {
  try {
    const { keyword } = req.body;
    if (!keyword || !keyword.trim()) {
      return res.status(400).json({ error: 'A keyword is required.' });
    }

    const listingResult = await pool.query(
      `SELECT * FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.id, req.customer.id]
    );
    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    const listing = listingResult.rows[0];

    const { plan } = await getCustomerPlanStatus(req.customer.id);
    const limit = TIER_LIMITS[plan]?.extraKeywordsLimit ?? 0;

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM tracked_keywords WHERE tracked_listing_id = $1`,
      [req.params.id]
    );
    const currentCount = parseInt(countResult.rows[0].count, 10);
    if (currentCount >= limit) {
      return res.status(403).json({
        error: limit === 0
          ? 'Tracking additional keywords is available on Grow and Pro plans.'
          : `You've reached your plan's limit of ${limit} additional tracked keyword${limit === 1 ? '' : 's'} for this listing. Remove one to add another, or upgrade for a higher limit.`,
      });
    }

    let position = null;
    try {
      const rank = await runRankCheck(keyword.trim(), listing.location, listing.business_name, listing.google_place_id);
      position = rank.position;
    } catch (checkErr) {
      console.error('tracked-keyword initial check failed:', checkErr.message);
      // Still save the keyword even if the first check fails — the
      // scheduled job will pick it up on the next cycle.
    }

    const result = await pool.query(
      `INSERT INTO tracked_keywords (tracked_listing_id, keyword, local_pack_position, last_checked_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (tracked_listing_id, keyword) DO UPDATE SET local_pack_position = $3, last_checked_at = now()
       RETURNING *`,
      [req.params.id, keyword.trim(), position]
    );

    res.json({ keyword: result.rows[0] });
  } catch (err) {
    console.error('add tracked-keyword error:', err.message);
    res.status(500).json({ error: 'Could not add this keyword.' });
  }
});

app.delete('/api/tracked-listings/:listingId/keywords/:keywordId', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM tracked_keywords tk
       USING tracked_listings tl
       WHERE tk.id = $1 AND tk.tracked_listing_id = $2 AND tk.tracked_listing_id = tl.id AND tl.customer_id = $3
       RETURNING tk.id`,
      [req.params.keywordId, req.params.listingId, req.customer.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tracked keyword not found' });
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error('delete tracked-keyword error:', err.message);
    res.status(500).json({ error: 'Could not remove this keyword.' });
  }
});

// ---------------------------------------------------------------------------
// RANKHIGHPRO-HOSTED SITES (Grow & Pro)
// For customers with no website of their own, RankHighPro builds and
// deploys a real one on Netlify — AI-written, with schema markup and the
// tracked keyword correctly in place from day one, since we control the
// whole thing end to end. Requires NETLIFY_API_TOKEN in Railway.
// ---------------------------------------------------------------------------
async function createHostedSite(listing) {
  if (!process.env.NETLIFY_API_TOKEN) {
    throw new Error('Website hosting is not configured on the server yet.');
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured on the server.');
  }

  const contentPrompt = `Write clean, semantic HTML for a single-page local business website homepage for:
Business name: ${listing.business_name}
Location: ${listing.location}
What they do / keyword: ${listing.keyword}

Requirements:
- Return ONLY a complete, valid HTML document (starting with <!DOCTYPE html>) — no markdown fences, no explanation before or after.
- Include a <title> tag and a <meta name="description"> tag that both naturally include "${listing.keyword}".
- Include a LocalBusiness JSON-LD schema script in the <head> with the business name and location.
- Clean, modern, mobile-friendly inline CSS (no external stylesheets or frameworks, no external fonts).
- Sections: a hero with the business name and a one-line description, a short "About" section, and a "Contact" section mentioning the location (no fake phone/email — just say "Contact us to learn more").
- No placeholder images, no lorem ipsum — write genuine, specific-sounding copy for this exact type of business.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4000, messages: [{ role: 'user', content: contentPrompt }] }),
  });
  const data = await response.json();
  let html = data?.content?.map((b) => b.text || '').join('').trim() || '';
  html = html.replace(/```html|```/g, '').trim();
  if (!html.toLowerCase().startsWith('<!doctype')) {
    throw new Error('AI did not return a valid HTML document.');
  }

  const slugBase = listing.business_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const siteName = `${slugBase}-${Math.random().toString(36).slice(2, 7)}`;

  const createSiteResponse = await fetch('https://api.netlify.com/api/v1/sites', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.NETLIFY_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: siteName }),
  });
  const site = await createSiteResponse.json();
  if (!createSiteResponse.ok) {
    throw new Error(site?.message || 'Could not create the site on Netlify.');
  }

  // File-digest deploy — avoids needing a zip library. Netlify tells us
  // which files it doesn't already have (by SHA1), then we PUT the raw
  // content for each one directly.
  const sha1 = crypto.createHash('sha1').update(html, 'utf8').digest('hex');
  const deployResponse = await fetch(`https://api.netlify.com/api/v1/sites/${site.id}/deploys`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.NETLIFY_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: { '/index.html': sha1 } }),
  });
  const deploy = await deployResponse.json();
  if (!deployResponse.ok) {
    throw new Error(deploy?.message || 'Could not start the deploy on Netlify.');
  }

  if (Array.isArray(deploy.required) && deploy.required.includes(sha1)) {
    const uploadResponse = await fetch(`https://api.netlify.com/api/v1/deploys/${deploy.id}/files/index.html`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${process.env.NETLIFY_API_TOKEN}`, 'Content-Type': 'application/octet-stream' },
      body: html,
    });
    if (!uploadResponse.ok) {
      throw new Error('Could not upload the site file to Netlify.');
    }
  }

  return { siteId: site.id, siteUrl: site.ssl_url || site.url, siteName };
}

// ---------------------------------------------------------------------------
// POST /api/hosted-site/:listingId/create   (auth required, Grow & Pro)
// ---------------------------------------------------------------------------
app.post('/api/hosted-site/:listingId/create', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(
      `SELECT tl.*, c.plan FROM tracked_listings tl JOIN customers c ON c.id = tl.customer_id WHERE tl.id = $1 AND tl.customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });
    const listing = listingResult.rows[0];
    if (listing.plan !== 'grow' && listing.plan !== 'managed') {
      return res.status(403).json({ error: 'RankHighPro-hosted websites are available on Grow and Pro.' });
    }

    const existing = await pool.query(`SELECT * FROM hosted_sites WHERE tracked_listing_id = $1`, [req.params.listingId]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'This listing already has a RankHighPro-hosted site.', site: existing.rows[0] });
    }

    const built = await createHostedSite(listing);
    const result = await pool.query(
      `INSERT INTO hosted_sites (tracked_listing_id, netlify_site_id, site_name, site_url) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.listingId, built.siteId, built.siteName, built.siteUrl]
    );

    // Point the listing's website_url at the new site so the existing
    // schema/keyword checks immediately start checking it.
    await pool.query(`UPDATE tracked_listings SET website_url = $1 WHERE id = $2`, [built.siteUrl, req.params.listingId]);

    res.json({ site: result.rows[0] });
  } catch (err) {
    console.error('create hosted-site error:', err.message);
    res.status(500).json({ error: err.message || 'Could not build the website right now.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/hosted-site/:listingId   (auth required)
// ---------------------------------------------------------------------------
app.get('/api/hosted-site/:listingId', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(`SELECT id FROM tracked_listings WHERE id = $1 AND customer_id = $2`, [req.params.listingId, req.customer.id]);
    if (listingResult.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });
    const result = await pool.query(`SELECT * FROM hosted_sites WHERE tracked_listing_id = $1`, [req.params.listingId]);
    res.json({ site: result.rows[0] || null });
  } catch (err) {
    console.error('get hosted-site error:', err.message);
    res.status(500).json({ error: 'Could not load site info' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/wordpress/:listingId/disconnect   (auth required)
// ---------------------------------------------------------------------------
app.delete('/api/wordpress/:listingId/disconnect', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(`SELECT id FROM tracked_listings WHERE id = $1 AND customer_id = $2`, [req.params.listingId, req.customer.id]);
    if (listingResult.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });
    await pool.query(`DELETE FROM wordpress_connections WHERE tracked_listing_id = $1`, [req.params.listingId]);
    res.json({ disconnected: true });
  } catch (err) {
    console.error('wordpress disconnect error:', err.message);
    res.status(500).json({ error: 'Could not disconnect' });
  }
});

// Attempts to apply the LocalBusiness schema snippet directly to a
// connected WordPress site's front page via the standard WP REST API.
// Falls back cleanly — callers should escalate to the team ticket system
// if this returns { applied: false }, since real-world theme/plugin setups
// vary and we never want a fix to silently fail with no visibility.
// ---------------------------------------------------------------------------
// CUSTOMER'S OWN TWILIO CONNECTION (for text campaigns)
// Every RankHighPro customer connects and pays for their own Twilio
// account — campaigns never bill to RankHighPro. Same tested-before-saved,
// encrypted-credential pattern as the WordPress connection.
// ---------------------------------------------------------------------------
app.post('/api/twilio/connect', requireAuth, async (req, res) => {
  try {
    const { accountSid, authToken, phoneNumber } = req.body;
    if (!accountSid || !authToken || !phoneNumber) {
      return res.status(400).json({ error: 'accountSid, authToken, and phoneNumber are all required' });
    }

    const testAuth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const testResponse = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`, {
      headers: { Authorization: `Basic ${testAuth}` },
    });
    if (!testResponse.ok) {
      return res.status(400).json({ error: 'Could not connect with those details. Double check your Account SID and Auth Token.' });
    }

    let encryptedToken;
    try {
      encryptedToken = encryptSecret(authToken);
    } catch (encErr) {
      return res.status(500).json({ error: 'Server is not configured to store credentials securely yet. Contact support.' });
    }

    await pool.query(`DELETE FROM twilio_connections WHERE customer_id = $1`, [req.customer.id]);
    const result = await pool.query(
      `INSERT INTO twilio_connections (customer_id, account_sid, auth_token, phone_number)
       VALUES ($1, $2, $3, $4) RETURNING id, account_sid, phone_number, status, connected_at`,
      [req.customer.id, accountSid, encryptedToken, phoneNumber]
    );

    res.json({ connection: result.rows[0] });
  } catch (err) {
    console.error('twilio connect error:', err.message);
    res.status(500).json({ error: 'Could not connect to Twilio.' });
  }
});

app.get('/api/twilio/status', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, account_sid, phone_number, status, connected_at FROM twilio_connections WHERE customer_id = $1`,
      [req.customer.id]
    );
    res.json({ connection: result.rows[0] || null });
  } catch (err) {
    console.error('twilio status error:', err.message);
    res.status(500).json({ error: 'Could not load connection status' });
  }
});

app.delete('/api/twilio/disconnect', requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM twilio_connections WHERE customer_id = $1`, [req.customer.id]);
    res.json({ disconnected: true });
  } catch (err) {
    console.error('twilio disconnect error:', err.message);
    res.status(500).json({ error: 'Could not disconnect' });
  }
});

// Sends a text (or MMS, if mediaUrl is given) via a customer's OWN
// connected Twilio account (never RankHighPro's). Returns { sent: true }
// or { sent: false, reason }.
async function sendSmsViaCustomerTwilio(customerId, to, message, mediaUrl) {
  const connResult = await pool.query(
    `SELECT * FROM twilio_connections WHERE customer_id = $1 AND status = 'active'`,
    [customerId]
  );
  if (connResult.rows.length === 0) return { sent: false, reason: 'no_connection' };

  const conn = connResult.rows[0];
  let authToken;
  try {
    authToken = decryptSecret(conn.auth_token);
  } catch (err) {
    return { sent: false, reason: 'decrypt_failed' };
  }

  try {
    const auth = Buffer.from(`${conn.account_sid}:${authToken}`).toString('base64');
    const params = { From: conn.phone_number, To: to, Body: message };
    if (mediaUrl) params.MediaUrl = mediaUrl;
    const body = new URLSearchParams(params);
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${conn.account_sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!response.ok) return { sent: false, reason: 'send_failed' };
    return { sent: true };
  } catch (err) {
    console.error('sendSmsViaCustomerTwilio error:', err.message);
    return { sent: false, reason: 'exception' };
  }
}

// ---------------------------------------------------------------------------
// POST /api/campaigns/:listingId/generate-message
// AI drafts a promotional text message for this business — the customer
// can use it as-is, edit it, or write their own instead.
// ---------------------------------------------------------------------------
app.post('/api/campaigns/:listingId/generate-message', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(
      `SELECT * FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' });
    }
    const listing = listingResult.rows[0];

    const prompt = `Write a short promotional text message (SMS) for this business to send to their own customers about a sale, update, or news:
Business name: ${listing.business_name}
Location: ${listing.location}
What they're known for: ${listing.keyword}

Requirements:
- Under 300 characters total (leave room for an unsubscribe line that gets added automatically after)
- Upbeat, direct, feels like a real text from a local business, not a corporate blast
- No hashtags, no markdown formatting
- Return ONLY the message text, nothing else — no preamble, no quotation marks`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await response.json();
    const text = data?.content?.map((b) => b.text || '').join(' ').trim() || '';
    if (!text) throw new Error('AI did not return any message text.');

    res.json({ message: text });
  } catch (err) {
    console.error('generate campaign message error:', err.message);
    res.status(500).json({ error: 'Could not generate a message right now.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/campaigns/:listingId/generate-image
// AI generates a photo to send along with the campaign as an MMS.
// ---------------------------------------------------------------------------
app.post('/api/campaigns/:listingId/generate-image', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(
      `SELECT * FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY is not configured on the server.' });
    }
    const listing = listingResult.rows[0];

    const imagePrompt = `A clean, appealing, professional product/lifestyle photo suitable for a text message marketing campaign from a small local business. Business type/category: "${listing.keyword}". Warm, inviting, high-quality commercial photography style. Do not include any text, words, letters, or logos in the image.`;

    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-1', prompt: imagePrompt, size: '1024x1024' }),
    });
    const data = await response.json();
    if (!response.ok) {
      return res.status(502).json({ error: data?.error?.message || 'Could not generate an image right now.' });
    }
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) return res.status(502).json({ error: 'Image generation did not return any image data.' });

    const mediaResult = await pool.query(
      `INSERT INTO campaign_media (tracked_listing_id, image_base64, media_type) VALUES ($1, $2, 'image/png') RETURNING id`,
      [req.params.listingId, b64]
    );

    res.json({ mediaId: mediaResult.rows[0].id, mediaUrl: `${BACKEND_URL}/api/campaign-media/${mediaResult.rows[0].id}` });
  } catch (err) {
    console.error('generate campaign image error:', err.message);
    res.status(500).json({ error: 'Could not generate an image right now.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/campaigns/:listingId/upload-image
// Body: { image (base64), mediaType }
// Lets the customer use their own photo instead of an AI-generated one.
// ---------------------------------------------------------------------------
app.post('/api/campaigns/:listingId/upload-image', requireAuth, async (req, res) => {
  try {
    const { image, mediaType } = req.body;
    if (!image) return res.status(400).json({ error: 'image is required' });

    const listingResult = await pool.query(
      `SELECT id FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });

    const mediaResult = await pool.query(
      `INSERT INTO campaign_media (tracked_listing_id, image_base64, media_type) VALUES ($1, $2, $3) RETURNING id`,
      [req.params.listingId, image, mediaType || 'image/jpeg']
    );

    res.json({ mediaId: mediaResult.rows[0].id, mediaUrl: `${BACKEND_URL}/api/campaign-media/${mediaResult.rows[0].id}` });
  } catch (err) {
    console.error('upload campaign image error:', err.message);
    res.status(500).json({ error: 'Could not upload image' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/campaign-media/:id   (PUBLIC — no auth)
// Twilio's own servers fetch the MMS image directly from this URL, so it
// must be reachable without a login token. Only ever serves images the
// customer themselves generated or uploaded for their own campaign.
// ---------------------------------------------------------------------------
app.get('/api/campaign-media/:id', async (req, res) => {
  try {
    const result = await pool.query(`SELECT image_base64, media_type FROM campaign_media WHERE id = $1`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).send('Not found');
    const { image_base64, media_type } = result.rows[0];
    res.set('Content-Type', media_type);
    res.send(Buffer.from(image_base64, 'base64'));
  } catch (err) {
    console.error('serve campaign-media error:', err.message);
    res.status(500).send('Error');
  }
});

// ---------------------------------------------------------------------------
// CUSTOMER'S OWN RESEND CONNECTION (for email campaigns)
// Every RankHighPro customer connects and pays for their own Resend
// account, using their own verified sending domain — campaigns never bill
// to RankHighPro or risk RankHighPro's own sending reputation.
// ---------------------------------------------------------------------------
app.post('/api/resend/connect', requireAuth, async (req, res) => {
  try {
    const { plan } = await getCustomerPlanStatus(req.customer.id);
    if (plan === 'watch') {
      return res.status(403).json({ error: 'Email marketing campaigns are available on Grow and Pro plans. Upgrade to unlock this feature.' });
    }

    const { apiKey, fromEmail, fromName, mailingAddress } = req.body;
    if (!apiKey || !fromEmail || !fromName) {
      return res.status(400).json({ error: 'apiKey, fromEmail, and fromName are all required' });
    }

    const testResponse = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!testResponse.ok) {
      return res.status(400).json({ error: 'Could not connect with that API key. Double check it in your Resend dashboard.' });
    }

    let encryptedKey;
    try {
      encryptedKey = encryptSecret(apiKey);
    } catch (encErr) {
      return res.status(500).json({ error: 'Server is not configured to store credentials securely yet. Contact support.' });
    }

    await pool.query(`DELETE FROM resend_connections WHERE customer_id = $1`, [req.customer.id]);
    const result = await pool.query(
      `INSERT INTO resend_connections (customer_id, api_key, from_email, from_name, mailing_address)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, from_email, from_name, mailing_address, status, connected_at`,
      [req.customer.id, encryptedKey, fromEmail, fromName, mailingAddress || null]
    );

    res.json({ connection: result.rows[0] });
  } catch (err) {
    console.error('resend connect error:', err.message);
    res.status(500).json({ error: 'Could not connect to Resend.' });
  }
});

app.get('/api/resend/status', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, from_email, from_name, mailing_address, status, connected_at FROM resend_connections WHERE customer_id = $1`,
      [req.customer.id]
    );
    res.json({ connection: result.rows[0] || null });
  } catch (err) {
    console.error('resend status error:', err.message);
    res.status(500).json({ error: 'Could not load connection status' });
  }
});

app.delete('/api/resend/disconnect', requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM resend_connections WHERE customer_id = $1`, [req.customer.id]);
    res.json({ disconnected: true });
  } catch (err) {
    console.error('resend disconnect error:', err.message);
    res.status(500).json({ error: 'Could not disconnect' });
  }
});

// Sends one email via a customer's OWN connected Resend account (never
// RankHighPro's). Returns { sent: true } or { sent: false, reason }.
async function sendEmailViaCustomerResend(customerId, to, subject, html) {
  const connResult = await pool.query(
    `SELECT * FROM resend_connections WHERE customer_id = $1 AND status = 'active'`,
    [customerId]
  );
  if (connResult.rows.length === 0) return { sent: false, reason: 'no_connection' };

  const conn = connResult.rows[0];
  let apiKey;
  try {
    apiKey = decryptSecret(conn.api_key);
  } catch (err) {
    return { sent: false, reason: 'decrypt_failed' };
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${conn.from_name} <${conn.from_email}>`,
        to,
        subject,
        html,
      }),
    });
    if (!response.ok) return { sent: false, reason: 'send_failed' };
    return { sent: true };
  } catch (err) {
    console.error('sendEmailViaCustomerResend error:', err.message);
    return { sent: false, reason: 'exception' };
  }
}

// ---------------------------------------------------------------------------
// POST /api/email-campaigns/:listingId/generate-content
// Body: { goal: 'story' | 'sale' }
// AI drafts either a storytelling brand post or a sale/promo announcement.
// ---------------------------------------------------------------------------
app.post('/api/email-campaigns/:listingId/generate-content', requireAuth, async (req, res) => {
  try {
    const { plan } = await getCustomerPlanStatus(req.customer.id);
    if (plan === 'watch') {
      return res.status(403).json({ error: 'Email marketing campaigns are available on Grow and Pro plans. Upgrade to unlock this feature.' });
    }

    const { goal } = req.body;
    const listingResult = await pool.query(
      `SELECT * FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' });
    }
    const listing = listingResult.rows[0];

    const prompt = goal === 'story'
      ? `Write a warm, genuine storytelling email for this small business to send to their own customers — the kind of email that builds connection and brand loyalty, not a hard sell:
Business name: ${listing.business_name}
Location: ${listing.location}
What they're known for: ${listing.keyword}

Requirements:
- A short, warm subject line
- A body of 150-250 words telling a genuine, specific-feeling story — something like why the business started, a value they hold, or a moment with a customer. Write it like a real person wrote it, not corporate copy.
- End with a soft, low-pressure call to action (e.g. "stop by," "reach out," "check out what's new")
- Simple HTML formatting only (a few <p> tags, maybe one <strong>) — no complex design
- Return ONLY valid JSON in this exact shape, nothing else: {"subject": "...", "bodyHtml": "..."}`
      : `Write a promotional sale/announcement email for this small business to send to their own customers:
Business name: ${listing.business_name}
Location: ${listing.location}
What they're known for: ${listing.keyword}

Requirements:
- A short, attention-grabbing subject line mentioning the offer/news
- A body of 100-200 words that's upbeat, clear about the offer or update, and creates gentle urgency
- End with a clear call to action
- Simple HTML formatting only (a few <p> tags, maybe one <strong>) — no complex design
- Return ONLY valid JSON in this exact shape, nothing else: {"subject": "...", "bodyHtml": "..."}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await response.json();
    const raw = data?.content?.map((b) => b.text || '').join('').trim() || '';
    const cleaned = raw.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      throw new Error('AI did not return valid content JSON.');
    }
    if (!parsed.subject || !parsed.bodyHtml) {
      throw new Error('AI response was missing subject or bodyHtml.');
    }

    res.json(parsed);
  } catch (err) {
    console.error('generate email content error:', err.message);
    res.status(500).json({ error: 'Could not generate email content right now.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/email-campaigns/:listingId/send
// Body: { subject, bodyHtml }
// Sends to every contact with an email on file who hasn't opted out.
// Automatically appends an unsubscribe link and the business's mailing
// address — both are real CAN-SPAM requirements for commercial email, not
// just a formality.
// ---------------------------------------------------------------------------
app.post('/api/email-campaigns/:listingId/send', requireAuth, async (req, res) => {
  try {
    const { plan } = await getCustomerPlanStatus(req.customer.id);
    if (plan === 'watch') {
      return res.status(403).json({ error: 'Email marketing campaigns are available on Grow and Pro plans. Upgrade to unlock this feature.' });
    }

    const { subject, bodyHtml } = req.body;
    if (!subject || !subject.trim() || !bodyHtml || !bodyHtml.trim()) {
      return res.status(400).json({ error: 'Subject and message body are required' });
    }

    const listingResult = await pool.query(
      `SELECT id FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });

    const connResult = await pool.query(
      `SELECT mailing_address FROM resend_connections WHERE customer_id = $1 AND status = 'active'`,
      [req.customer.id]
    );
    if (connResult.rows.length === 0) {
      return res.status(400).json({ error: 'Connect your Resend account first before sending a campaign.' });
    }
    const mailingAddress = connResult.rows[0].mailing_address;

    const contactsResult = await pool.query(
      `SELECT * FROM customer_contacts WHERE tracked_listing_id = $1 AND email IS NOT NULL AND email_opted_out = false`,
      [req.params.listingId]
    );
    if (contactsResult.rows.length === 0) {
      return res.status(400).json({ error: 'No contacts with an email on file to send to yet.' });
    }

    let sentCount = 0;
    let failedCount = 0;

    for (const contact of contactsResult.rows) {
      const unsubscribeUrl = `${BACKEND_URL}/api/email-unsubscribe/${contact.id}`;
      const fullHtml = `
        ${bodyHtml}
        <hr style="margin:24px 0; border:none; border-top:1px solid #eee;">
        <p style="font-size:11px; color:#999; line-height:1.5;">
          ${mailingAddress ? mailingAddress + '<br>' : ''}
          <a href="${unsubscribeUrl}" style="color:#999;">Unsubscribe</a> from these emails.
        </p>
      `;
      const result = await sendEmailViaCustomerResend(req.customer.id, contact.email, subject.trim(), fullHtml);
      if (result.sent) sentCount++;
      else failedCount++;
    }

    const campaignResult = await pool.query(
      `INSERT INTO email_campaigns (tracked_listing_id, subject, body_html, recipient_count, sent_count, failed_count)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.params.listingId, subject.trim(), bodyHtml.trim(), contactsResult.rows.length, sentCount, failedCount]
    );

    res.json({ campaign: campaignResult.rows[0] });
  } catch (err) {
    console.error('send email campaign error:', err.message);
    res.status(500).json({ error: 'Could not send campaign' });
  }
});

app.get('/api/email-campaigns/:listingId', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(
      `SELECT id FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });

    const result = await pool.query(
      `SELECT * FROM email_campaigns WHERE tracked_listing_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [req.params.listingId]
    );
    res.json({ campaigns: result.rows });
  } catch (err) {
    console.error('list email campaigns error:', err.message);
    res.status(500).json({ error: 'Could not load campaign history' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/email-unsubscribe/:contactId   (PUBLIC — no auth)
// A required CAN-SPAM mechanism — the link every campaign email includes.
// ---------------------------------------------------------------------------
app.get('/api/email-unsubscribe/:contactId', async (req, res) => {
  try {
    await pool.query(`UPDATE customer_contacts SET email_opted_out = true WHERE id = $1`, [req.params.contactId]);
    res.send('<html><body style="font-family:sans-serif; text-align:center; padding:60px 20px;"><h2>You\'ve been unsubscribed.</h2><p>You will not receive any more emails from this list.</p></body></html>');
  } catch (err) {
    console.error('email-unsubscribe error:', err.message);
    res.status(500).send('Something went wrong.');
  }
});

// ---------------------------------------------------------------------------
// CUSTOMER CONTACTS
// Manually entered by the business owner. consent_confirmed is required —
// RankHighPro has no way to verify consent itself, so the checkbox is the
// business owner's own attestation that they have permission to text this
// person. This is a real legal requirement (TCPA), not a formality.
// ---------------------------------------------------------------------------
app.post('/api/contacts/:listingId', requireAuth, async (req, res) => {
  try {
    const { name, phone, email, consentConfirmed } = req.body;
    if (!name || (!phone && !email)) {
      return res.status(400).json({ error: 'name and at least a phone number or email are required' });
    }
    if (!consentConfirmed) {
      return res.status(400).json({ error: 'You must confirm you have permission to contact this person before saving them.' });
    }

    const listingResult = await pool.query(
      `SELECT id FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });

    const result = await pool.query(
      `INSERT INTO customer_contacts (tracked_listing_id, name, phone, email, consent_confirmed) VALUES ($1, $2, $3, $4, true) RETURNING *`,
      [req.params.listingId, name, phone || null, email || null]
    );
    res.json({ contact: result.rows[0] });
  } catch (err) {
    console.error('add contact error:', err.message);
    res.status(500).json({ error: 'Could not add contact' });
  }
});

app.get('/api/contacts/:listingId', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(
      `SELECT id FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });

    const result = await pool.query(
      `SELECT * FROM customer_contacts WHERE tracked_listing_id = $1 ORDER BY created_at DESC`,
      [req.params.listingId]
    );
    res.json({ contacts: result.rows });
  } catch (err) {
    console.error('list contacts error:', err.message);
    res.status(500).json({ error: 'Could not load contacts' });
  }
});

app.delete('/api/contacts/:listingId/:contactId', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(
      `SELECT id FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });

    await pool.query(
      `DELETE FROM customer_contacts WHERE id = $1 AND tracked_listing_id = $2`,
      [req.params.contactId, req.params.listingId]
    );
    res.json({ deleted: true });
  } catch (err) {
    console.error('delete contact error:', err.message);
    res.status(500).json({ error: 'Could not delete contact' });
  }
});

// ---------------------------------------------------------------------------
// SMS CAMPAIGNS
// Sends one message to every non-opted-out contact on a listing, via the
// customer's OWN connected Twilio account. Always appends the required
// opt-out line.
// ---------------------------------------------------------------------------
app.post('/api/campaigns/:listingId/send', requireAuth, async (req, res) => {
  try {
    const { message, mediaUrl } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const listingResult = await pool.query(
      `SELECT id FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });

    const connResult = await pool.query(
      `SELECT id FROM twilio_connections WHERE customer_id = $1 AND status = 'active'`,
      [req.customer.id]
    );
    if (connResult.rows.length === 0) {
      return res.status(400).json({ error: 'Connect your Twilio account first before sending a campaign.' });
    }

    const contactsResult = await pool.query(
      `SELECT * FROM customer_contacts WHERE tracked_listing_id = $1 AND opted_out = false`,
      [req.params.listingId]
    );
    if (contactsResult.rows.length === 0) {
      return res.status(400).json({ error: 'No contacts to send to yet.' });
    }

    const fullMessage = `${message.trim()}\n\nReply STOP to unsubscribe.`;
    let sentCount = 0;
    let failedCount = 0;

    for (const contact of contactsResult.rows) {
      const result = await sendSmsViaCustomerTwilio(req.customer.id, contact.phone, fullMessage, mediaUrl || null);
      if (result.sent) sentCount++;
      else failedCount++;
    }

    const campaignResult = await pool.query(
      `INSERT INTO sms_campaigns (tracked_listing_id, message, recipient_count, sent_count, failed_count)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.params.listingId, message.trim(), contactsResult.rows.length, sentCount, failedCount]
    );

    res.json({ campaign: campaignResult.rows[0] });
  } catch (err) {
    console.error('send campaign error:', err.message);
    res.status(500).json({ error: 'Could not send campaign' });
  }
});

app.get('/api/campaigns/:listingId', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(
      `SELECT id FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });

    const result = await pool.query(
      `SELECT * FROM sms_campaigns WHERE tracked_listing_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [req.params.listingId]
    );
    res.json({ campaigns: result.rows });
  } catch (err) {
    console.error('list campaigns error:', err.message);
    res.status(500).json({ error: 'Could not load campaign history' });
  }
});

// ---------------------------------------------------------------------------
// POST /webhook/sms-inbound?listingId=...
// A customer points their Twilio number's inbound webhook here so STOP
// replies get recorded. Twilio/carriers also auto-block at the network
// level in most cases, but this keeps RankHighPro's own list accurate for
// future campaigns.
// ---------------------------------------------------------------------------
app.post('/webhook/sms-inbound', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const { listingId } = req.query;
    const from = req.body.From;
    const body = (req.body.Body || '').trim().toUpperCase();

    if (listingId && from && ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(body)) {
      await pool.query(
        `UPDATE customer_contacts SET opted_out = true WHERE tracked_listing_id = $1 AND phone = $2`,
        [listingId, from]
      );
    }
    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>');
  } catch (err) {
    console.error('sms-inbound webhook error:', err.message);
    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>');
  }
});

async function applyWordPressSchemaFix(listing) {
  const connResult = await pool.query(
    `SELECT * FROM wordpress_connections WHERE tracked_listing_id = $1 AND status = 'active'`,
    [listing.id]
  );
  if (connResult.rows.length === 0) return { applied: false, reason: 'no_connection' };

  const conn = connResult.rows[0];
  let appPassword;
  try {
    appPassword = decryptSecret(conn.wp_app_password);
  } catch (err) {
    return { applied: false, reason: 'decrypt_failed' };
  }

  const auth = Buffer.from(`${conn.wp_username}:${appPassword}`).toString('base64');
  const snippet = generateSchemaSnippet(listing);

  try {
    const rootResponse = await fetch(`${conn.site_url}/wp-json/`, { headers: { Authorization: `Basic ${auth}` } });
    const rootData = await rootResponse.json();
    let frontPageId = rootData?.page_on_front || null;

    if (!frontPageId) {
      const pagesResponse = await fetch(`${conn.site_url}/wp-json/wp/v2/pages?per_page=1&orderby=menu_order&order=asc`, {
        headers: { Authorization: `Basic ${auth}` },
      });
      const pages = await pagesResponse.json();
      if (Array.isArray(pages) && pages.length > 0) frontPageId = pages[0].id;
    }
    if (!frontPageId) return { applied: false, reason: 'no_front_page_found' };

    const pageResponse = await fetch(`${conn.site_url}/wp-json/wp/v2/pages/${frontPageId}?context=edit`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    const page = await pageResponse.json();
    const existingContent = page?.content?.raw ?? page?.content?.rendered ?? '';

    if (existingContent.includes('application/ld+json')) {
      return { applied: false, reason: 'already_present' };
    }

    const updateResponse = await fetch(`${conn.site_url}/wp-json/wp/v2/pages/${frontPageId}`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: existingContent + '\n' + snippet }),
    });
    if (!updateResponse.ok) return { applied: false, reason: 'update_failed' };

    return { applied: true };
  } catch (err) {
    console.error('applyWordPressSchemaFix error:', err.message);
    return { applied: false, reason: 'exception' };
  }
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

    const result = await checkSchemaMarkup(listing.website_url, listing.keyword);
    if (!result.found) {
      return res.status(502).json({ error: `Could not load the website to check: ${result.error}` });
    }

    res.json({
      hasLocalBusinessSchema: result.hasLocalBusinessSchema,
      foundTypes: result.foundTypes,
      hasKeywordInTitle: result.hasKeywordInTitle,
      hasKeywordInMeta: result.hasKeywordInMeta,
      pageTitle: result.pageTitle,
      metaDescription: result.metaDescription,
      suggestedSnippet: result.hasLocalBusinessSchema ? null : generateSchemaSnippet(listing),
      fixSteps: generateWebsiteFixSteps(),
      websiteBuilder: listing.website_builder || null,
      fixInstructions: {
        schema: FIX_INSTRUCTIONS.missing_schema,
        keywordTitle: FIX_INSTRUCTIONS.keyword_missing_title,
        keywordMeta: FIX_INSTRUCTIONS.keyword_missing_meta,
      },
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
// POST /api/ai-visibility/:listingId/game-plan   (auth required)
// Generates a concrete, prioritized action plan for getting mentioned by
// whichever AI platforms didn't mention this business in its most recent
// check. Cached on that check row — repeat requests for the same check
// return the cached plan instead of calling Claude again, unless force:true
// is sent (e.g. after the customer fixes something and wants a fresh plan).
// ---------------------------------------------------------------------------
app.post('/api/ai-visibility/:listingId/game-plan', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(
      `SELECT * FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    const listing = listingResult.rows[0];

    const checkResult = await pool.query(
      `SELECT * FROM ai_visibility_checks WHERE tracked_listing_id = $1 ORDER BY checked_at DESC LIMIT 1`,
      [req.params.listingId]
    );
    if (checkResult.rows.length === 0) {
      return res.status(400).json({ error: 'Run an AI visibility check first, then generate a game plan.' });
    }
    const check = checkResult.rows[0];

    if (check.game_plan && !req.body.force) {
      return res.json({ gamePlan: check.game_plan, cached: true });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'The AI assistant is not configured right now.' });
    }

    const platforms = ['chatgpt', 'perplexity', 'gemini', 'grok', 'claude'];
    const mentioned = platforms.filter((p) => check[`${p}_mentioned`] === true);
    const notMentioned = platforms.filter((p) => check[`${p}_mentioned`] === false);

    if (notMentioned.length === 0) {
      const plan = 'Good news — every AI platform we checked already mentions this business. Keep doing what you\'re doing: stay active on Google Business Profile, keep review volume growing, and keep your website content and citations consistent.';
      await pool.query(
        `UPDATE ai_visibility_checks SET game_plan = $1, game_plan_generated_at = now() WHERE id = $2`,
        [plan, check.id]
      );
      return res.json({ gamePlan: plan, cached: false });
    }

    const prompt = `A local business was checked to see whether AI answer engines (ChatGPT, Perplexity, Gemini, Grok, Claude) mention it when someone asks for a recommendation. Here are the results.

Business name: ${listing.business_name}
Location: ${listing.location}
Business type / what they're known for: ${listing.business_category || listing.keyword}
Website: ${listing.website_url || 'not on file'}
Prompt that was asked to each AI: "${check.prompt_used}"

Mentioned: ${mentioned.length > 0 ? mentioned.join(', ') : 'none'}
NOT mentioned: ${notMentioned.join(', ')}

Write a short, concrete, prioritized game plan (4-6 numbered steps) this business owner can follow to start getting mentioned by AI platforms like the ones above. Ground it in real levers that actually influence AI answer-engine visibility: structured data/schema markup on their website, consistent NAP (name/address/phone) citations across directories like Yelp/Apple Maps/Bing Places, review volume and recency on Google, depth and specificity of their own website content, and being mentioned/linked by other authoritative local sites. Be specific to this business, not generic. No preamble — start directly with step 1. Keep each step to 1-2 sentences. This will be shown in a mobile dashboard, so keep the whole thing under 180 words.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await response.json();
    const gamePlan = data?.content?.map((b) => b.text || '').join(' ').trim();

    if (!gamePlan) {
      return res.status(502).json({ error: 'Could not generate a game plan right now — please try again.' });
    }

    await pool.query(
      `UPDATE ai_visibility_checks SET game_plan = $1, game_plan_generated_at = now() WHERE id = $2`,
      [gamePlan, check.id]
    );

    res.json({ gamePlan, cached: false });
  } catch (err) {
    console.error('ai-visibility game-plan error:', err.message);
    res.status(500).json({ error: 'Could not generate a game plan right now.' });
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
    return { imageBase64: null, error: 'OPENAI_API_KEY is not configured on the server.' };
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
      const message = data?.error?.message || `OpenAI returned HTTP ${response.status}`;
      console.error('GBP post image generation — OpenAI returned an error:', JSON.stringify(data));
      return { imageBase64: null, error: message };
    }

    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      console.error('GBP post image generation — no image data in response:', JSON.stringify(data));
      return { imageBase64: null, error: 'OpenAI responded successfully but did not include image data.' };
    }
    return { imageBase64: b64, error: null };
  } catch (err) {
    console.error('GBP post image generation failed:', err.message);
    return { imageBase64: null, error: err.message };
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

    const quota = await checkFeatureAllowed(req.customer.id, 'gbpPosts');
    if (!quota.allowed) {
      return res.status(403).json({ error: quota.error });
    }

    const listing = listingResult.rows[0];
    const [content, imageResult] = await Promise.all([
      generateGbpPostContent(listing),
      generateGbpPostImage(listing),
    ]);

    const result = await pool.query(
      `INSERT INTO gbp_posts (tracked_listing_id, content, image_base64, image_error) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.listingId, content, imageResult.imageBase64, imageResult.error]
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
      `DELETE FROM gbp_posts
       WHERE id = $1 AND tracked_listing_id IN (SELECT id FROM tracked_listings WHERE customer_id = $2)
       RETURNING id`,
      [req.params.id, req.customer.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error('reject gbp-post error:', err.message);
    res.status(500).json({ error: 'Could not reject post' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/gbp-posts/:id   (auth required, must own the parent listing)
// Lets a customer permanently remove a post from their history (e.g. to
// declutter the dashboard once it's been posted or rejected).
// ---------------------------------------------------------------------------
app.delete('/api/gbp-posts/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM gbp_posts
       WHERE id = $1 AND tracked_listing_id IN (SELECT id FROM tracked_listings WHERE customer_id = $2)
       RETURNING id`,
      [req.params.id, req.customer.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error('delete gbp-post error:', err.message);
    res.status(500).json({ error: 'Could not delete post' });
  }
});

// ---------------------------------------------------------------------------
// SOCIAL AD (Facebook/Instagram) CONTENT GENERATOR
// Uses Claude to draft a headline, body copy, and suggested call-to-action
// button label as strict JSON, which we parse into the three separate
// fields the dashboard displays.
// ---------------------------------------------------------------------------
async function generateSocialAdContent(listing) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured.');
  }

  const prompt = `Write Facebook/Instagram ad creative for this business:
Business name: ${listing.business_name}
Location: ${listing.location}
What they're known for / tracked keyword: ${listing.keyword}

Requirements:
- A short, punchy headline (under 40 characters)
- Body ad copy (under 125 characters), upbeat and specific, not generic
- DO NOT assume the business has a physical storefront customers walk into — do not say "stop by," "visit us," or "come in." The business format is unknown (delivery-only, online-only, appointment-based, or storefront). Use neutral action language instead.
- A suggested call-to-action button label — choose exactly one of: "Learn More", "Shop Now", "Order Now", "Send Message", "Call Now"
- No hashtags, no emojis, no markdown formatting

Return ONLY valid JSON in this exact shape, with no other text before or after it:
{"headline": "...", "body_text": "...", "cta": "..."}`;

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
  const raw = data?.content?.map((block) => block.text || '').join(' ').trim() || '';
  if (!raw) throw new Error('AI did not return any ad content.');

  // Strip markdown code fences in case the model wraps the JSON in ```json ... ```
  const cleaned = raw.replace(/```json|```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error('AI did not return valid ad JSON.');
  }

  if (!parsed.headline || !parsed.body_text || !parsed.cta) {
    throw new Error('AI response was missing headline, body_text, or cta.');
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// SOCIAL AD IMAGE GENERATOR
// Same approach as the GBP post image generator: a clean square photo, no
// text/logos baked in (AI image generators are unreliable at spelling).
// ---------------------------------------------------------------------------
async function generateSocialAdImage(listing) {
  if (!process.env.OPENAI_API_KEY) {
    return { imageBase64: null, error: 'OPENAI_API_KEY is not configured on the server.' };
  }

  try {
    const imagePrompt = `A clean, appealing, professional product/lifestyle photo suitable for a small local business's Facebook and Instagram ad. Business type/category: "${listing.keyword}". Warm, inviting, high-quality commercial photography style, eye-catching for a social feed. Do not include any text, words, letters, or logos in the image.`;

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
      const message = data?.error?.message || `OpenAI returned HTTP ${response.status}`;
      console.error('Social ad image generation — OpenAI returned an error:', JSON.stringify(data));
      return { imageBase64: null, error: message };
    }

    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      console.error('Social ad image generation — no image data in response:', JSON.stringify(data));
      return { imageBase64: null, error: 'OpenAI responded successfully but did not include image data.' };
    }
    return { imageBase64: b64, error: null };
  } catch (err) {
    console.error('Social ad image generation failed:', err.message);
    return { imageBase64: null, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// POST /api/social-ads/:listingId/generate   (auth required)
// ---------------------------------------------------------------------------
app.post('/api/social-ads/:listingId/generate', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(
      `SELECT * FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    const quota = await checkFeatureAllowed(req.customer.id, 'aiContent');
    if (!quota.allowed) {
      return res.status(403).json({ error: quota.error });
    }

    const listing = listingResult.rows[0];
    const [content, imageResult] = await Promise.all([
      generateSocialAdContent(listing),
      generateSocialAdImage(listing),
    ]);

    const result = await pool.query(
      `INSERT INTO social_ads (tracked_listing_id, headline, body_text, cta, image_base64, image_error)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.params.listingId, content.headline, content.body_text, content.cta, imageResult.imageBase64, imageResult.error]
    );

    res.json({ ad: result.rows[0] });
  } catch (err) {
    console.error('generate social-ad error:', err.message);
    res.status(500).json({ error: 'Could not generate an ad right now.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/social-ads?trackedListingId=...   (auth required)
// ---------------------------------------------------------------------------
app.get('/api/social-ads', requireAuth, async (req, res) => {
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
      `SELECT * FROM social_ads WHERE tracked_listing_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [trackedListingId]
    );
    res.json({ ads: result.rows });
  } catch (err) {
    console.error('list social-ads error:', err.message);
    res.status(500).json({ error: 'Could not load ads' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/social-ads/:id/approve   (auth required)
// PATCH /api/social-ads/:id/reject    (auth required)
// ---------------------------------------------------------------------------
app.patch('/api/social-ads/:id/approve', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE social_ads SET status = 'approved', decided_at = now()
       WHERE id = $1 AND tracked_listing_id IN (SELECT id FROM tracked_listings WHERE customer_id = $2)
       RETURNING *`,
      [req.params.id, req.customer.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ad not found' });
    }
    res.json({ ad: result.rows[0] });
  } catch (err) {
    console.error('approve social-ad error:', err.message);
    res.status(500).json({ error: 'Could not approve ad' });
  }
});

app.patch('/api/social-ads/:id/reject', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM social_ads
       WHERE id = $1 AND tracked_listing_id IN (SELECT id FROM tracked_listings WHERE customer_id = $2)
       RETURNING id`,
      [req.params.id, req.customer.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ad not found' });
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error('reject social-ad error:', err.message);
    res.status(500).json({ error: 'Could not reject ad' });
  }
});

// ---------------------------------------------------------------------------
// SOCIAL MEDIA MARKETING POSTS (Grow & Pro)
// Organic content — sales, product updates, general posts, storytelling,
// and "did you know" posts — distinct from the paid ad creative above.
// ---------------------------------------------------------------------------
const SOCIAL_POST_GOALS = {
  sale: {
    label: 'Sale/promo',
    prompt: (listing) => `Write a short, upbeat social media post announcing a sale or promotion for this business:
Business name: ${listing.business_name}
Location: ${listing.location}
What they're known for: ${listing.keyword}

Requirements:
- Under 200 characters, feels like a real small-business owner wrote it, not corporate copy
- Clear about the offer, with gentle urgency and a simple call to action
- No hashtag spam (max 1-2 if natural), no markdown
- Return ONLY the post caption, nothing else`,
  },
  update: {
    label: 'Product/news update',
    prompt: (listing) => `Write a short social media post announcing a new product, service, or update for this business:
Business name: ${listing.business_name}
Location: ${listing.location}
What they're known for: ${listing.keyword}

Requirements:
- Under 200 characters, upbeat and specific
- Sounds like real news customers would care about, not generic filler
- Return ONLY the post caption, nothing else`,
  },
  general: {
    label: 'General post',
    prompt: (listing) => `Write a short, friendly general social media post for this business — just a nice everyday post to stay visible and engaged with followers, no specific offer:
Business name: ${listing.business_name}
Location: ${listing.location}
What they're known for: ${listing.keyword}

Requirements:
- Under 200 characters, warm and genuine
- Return ONLY the post caption, nothing else`,
  },
  story: {
    label: 'Storytelling',
    prompt: (listing) => `Write a short, genuine storytelling social media post for this business — the kind that builds real connection, not a sales pitch:
Business name: ${listing.business_name}
Location: ${listing.location}
What they're known for: ${listing.keyword}

Requirements:
- 150-280 characters, tells a small, specific-feeling story — why the business started, a value they hold, a moment with a customer
- Write it like a real person, not corporate copy
- Return ONLY the post caption, nothing else`,
  },
  did_you_know: {
    label: '"Did you know?"',
    prompt: (listing) => `Write a short, genuinely interesting "did you know?" style social media post related to this business's industry — something that educates or surprises the reader, building authority without selling:
Business name: ${listing.business_name}
Location: ${listing.location}
What they're known for: ${listing.keyword}

Requirements:
- Starts with or clearly implies "Did you know..."
- Under 220 characters, a genuinely interesting, true-feeling fact or tip related to their industry
- Return ONLY the post caption, nothing else`,
  },
};

async function generateSocialMediaPostContent(listing, goal) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured.');
  const goalConfig = SOCIAL_POST_GOALS[goal];
  if (!goalConfig) throw new Error('Unknown post goal.');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: goalConfig.prompt(listing) }] }),
  });
  const data = await response.json();
  const text = data?.content?.map((b) => b.text || '').join(' ').trim() || '';
  if (!text) throw new Error('AI did not return any post content.');
  return text;
}

async function generateSocialMediaPostImage(listing, goal) {
  if (!process.env.OPENAI_API_KEY) {
    return { imageBase64: null, error: 'OPENAI_API_KEY is not configured on the server.' };
  }
  try {
    const styleHint = goal === 'story' || goal === 'did_you_know'
      ? 'warm, editorial, storytelling photography style'
      : 'clean, appealing, professional commercial photography style';
    const imagePrompt = `A ${styleHint} photo suitable for a small local business's social media post. Business type/category: "${listing.keyword}". Do not include any text, words, letters, or logos in the image.`;

    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-1', prompt: imagePrompt, size: '1024x1024' }),
    });
    const data = await response.json();
    if (!response.ok) {
      return { imageBase64: null, error: data?.error?.message || `OpenAI returned HTTP ${response.status}` };
    }
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) return { imageBase64: null, error: 'OpenAI responded successfully but did not include image data.' };
    return { imageBase64: b64, error: null };
  } catch (err) {
    console.error('Social media post image generation failed:', err.message);
    return { imageBase64: null, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// POST /api/social-media-posts/:listingId/generate   (Grow & Pro)
// Body: { goal }
// ---------------------------------------------------------------------------
app.post('/api/social-media-posts/:listingId/generate', requireAuth, async (req, res) => {
  try {
    const { plan } = await getCustomerPlanStatus(req.customer.id);
    if (plan === 'watch') {
      return res.status(403).json({ error: 'Social media marketing content is available on Grow and Pro plans. Upgrade to unlock this feature.' });
    }

    const { goal } = req.body;
    if (!SOCIAL_POST_GOALS[goal]) {
      return res.status(400).json({ error: 'A valid goal is required.' });
    }

    const listingResult = await pool.query(
      `SELECT * FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });
    const listing = listingResult.rows[0];

    const [caption, imageResult] = await Promise.all([
      generateSocialMediaPostContent(listing, goal),
      generateSocialMediaPostImage(listing, goal),
    ]);

    const result = await pool.query(
      `INSERT INTO social_media_posts (tracked_listing_id, goal, caption, image_base64, image_error) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.params.listingId, goal, caption, imageResult.imageBase64, imageResult.error]
    );

    res.json({ post: result.rows[0] });
  } catch (err) {
    console.error('generate social-media-post error:', err.message);
    res.status(500).json({ error: 'Could not generate a post right now.' });
  }
});

app.get('/api/social-media-posts/:listingId', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(
      `SELECT id FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });

    const result = await pool.query(
      `SELECT * FROM social_media_posts WHERE tracked_listing_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [req.params.listingId]
    );
    res.json({ posts: result.rows, goals: SOCIAL_POST_GOALS });
  } catch (err) {
    console.error('list social-media-posts error:', err.message);
    res.status(500).json({ error: 'Could not load posts' });
  }
});

app.patch('/api/social-media-posts/:id/approve', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE social_media_posts SET status = 'approved', decided_at = now()
       WHERE id = $1 AND tracked_listing_id IN (SELECT id FROM tracked_listings WHERE customer_id = $2)
       RETURNING *`,
      [req.params.id, req.customer.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Post not found' });
    res.json({ post: result.rows[0] });
  } catch (err) {
    console.error('approve social-media-post error:', err.message);
    res.status(500).json({ error: 'Could not approve post' });
  }
});

// Rejecting also immediately generates a fresh replacement for the same
// goal, matching "if rejected, AI generates another post."
app.patch('/api/social-media-posts/:id/reject', requireAuth, async (req, res) => {
  try {
    const existingResult = await pool.query(
      `SELECT smp.*, tl.* FROM social_media_posts smp
       JOIN tracked_listings tl ON tl.id = smp.tracked_listing_id
       WHERE smp.id = $1 AND tl.customer_id = $2`,
      [req.params.id, req.customer.id]
    );
    if (existingResult.rows.length === 0) return res.status(404).json({ error: 'Post not found' });
    const existing = existingResult.rows[0];

    await pool.query(`DELETE FROM social_media_posts WHERE id = $1`, [req.params.id]);

    const listing = existing;
    const [caption, imageResult] = await Promise.all([
      generateSocialMediaPostContent(listing, existing.goal),
      generateSocialMediaPostImage(listing, existing.goal),
    ]);
    const newPostResult = await pool.query(
      `INSERT INTO social_media_posts (tracked_listing_id, goal, caption, image_base64, image_error) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [existing.tracked_listing_id, existing.goal, caption, imageResult.imageBase64, imageResult.error]
    );

    res.json({ post: newPostResult.rows[0] });
  } catch (err) {
    console.error('reject social-media-post error:', err.message);
    res.status(500).json({ error: 'Could not reject post' });
  }
});

// ---------------------------------------------------------------------------
// CITATION BUILDING (Grow & Pro)
// No legitimate third-party API exists to auto-submit or fix listings on
// Yelp, Apple Maps, Bing Places, etc. This is a guided checklist: AI gives
// the customer their exact canonical NAP (name/address/phone) to use
// everywhere, and tracks which directories they've manually confirmed.
// ---------------------------------------------------------------------------
const CITATION_DIRECTORIES = [
  { key: 'yelp', name: 'Yelp', url: 'https://biz.yelp.com' },
  { key: 'apple_maps', name: 'Apple Maps', url: 'https://mapsconnect.apple.com' },
  { key: 'bing_places', name: 'Bing Places', url: 'https://www.bingplaces.com' },
  { key: 'nextdoor', name: 'Nextdoor Business', url: 'https://business.nextdoor.com' },
  { key: 'yellow_pages', name: 'Yellow Pages', url: 'https://accounts.yellowpages.com' },
  { key: 'bbb', name: 'Better Business Bureau', url: 'https://www.bbb.org' },
];

app.get('/api/citations/:listingId/nap', requireAuth, async (req, res) => {
  try {
    const { plan } = await getCustomerPlanStatus(req.customer.id);
    if (plan === 'watch') {
      return res.status(403).json({ error: 'Citation building is available on Grow and Pro plans. Upgrade to unlock this feature.' });
    }

    const listingResult = await pool.query(
      `SELECT * FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });
    const listing = listingResult.rows[0];

    const gbp = await runGbpAudit(listing.business_name, listing.location, listing.google_place_id);

    res.json({
      businessName: listing.business_name,
      address: listing.location,
      phone: gbp.found ? gbp.phone || null : null,
      website: listing.website_url || null,
      directories: CITATION_DIRECTORIES,
    });
  } catch (err) {
    console.error('citations nap error:', err.message);
    res.status(500).json({ error: 'Could not load business info' });
  }
});

app.get('/api/citations/:listingId/checklist', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(
      `SELECT id FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });

    const result = await pool.query(
      `SELECT directory_name, completed FROM citation_checklist WHERE tracked_listing_id = $1`,
      [req.params.listingId]
    );
    res.json({ checklist: result.rows });
  } catch (err) {
    console.error('citations checklist error:', err.message);
    res.status(500).json({ error: 'Could not load checklist' });
  }
});

app.patch('/api/citations/:listingId/checklist', requireAuth, async (req, res) => {
  try {
    const { directoryName, completed } = req.body;
    if (!directoryName) return res.status(400).json({ error: 'directoryName is required' });

    const listingResult = await pool.query(
      `SELECT id FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });

    await pool.query(
      `INSERT INTO citation_checklist (tracked_listing_id, directory_name, completed, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (tracked_listing_id, directory_name)
       DO UPDATE SET completed = $3, updated_at = now()`,
      [req.params.listingId, directoryName, !!completed]
    );

    res.json({ saved: true });
  } catch (err) {
    console.error('update citation checklist error:', err.message);
    res.status(500).json({ error: 'Could not save checklist' });
  }
});

// ---------------------------------------------------------------------------
// X (TWITTER) POST CONTENT GENERATOR
// Uses Claude to draft a post hard-capped under 280 characters.
// ---------------------------------------------------------------------------
async function generateXPostContent(listing) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured.');
  }

  const prompt = `Write a single X (Twitter) post for this business:
Business name: ${listing.business_name}
Location: ${listing.location}
What they're known for / tracked keyword: ${listing.keyword}

Requirements:
- MUST be under 280 characters total, ideally 200-260
- Upbeat and specific, not generic
- DO NOT assume the business has a physical storefront customers walk into — do not say "stop by," "visit us," or "come in." The business format is unknown (delivery-only, online-only, appointment-based, or storefront). Use neutral action language instead.
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
  let text = data?.content?.map((block) => block.text || '').join(' ').trim() || '';
  if (!text) throw new Error('AI did not return any post content.');

  // Hard safety cap in case the model runs a little long.
  if (text.length > 280) text = text.slice(0, 277) + '...';
  return text;
}

// ---------------------------------------------------------------------------
// X POST IMAGE GENERATOR
// Landscape image (1536x1024) to match X's card format.
// ---------------------------------------------------------------------------
async function generateXPostImage(listing) {
  if (!process.env.OPENAI_API_KEY) {
    return { imageBase64: null, error: 'OPENAI_API_KEY is not configured on the server.' };
  }

  try {
    const imagePrompt = `A clean, appealing, professional product/lifestyle photo suitable for a small local business's X (Twitter) post. Business type/category: "${listing.keyword}". Warm, inviting, high-quality commercial photography style. Do not include any text, words, letters, or logos in the image.`;

    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt: imagePrompt,
        size: '1536x1024',
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      const message = data?.error?.message || `OpenAI returned HTTP ${response.status}`;
      console.error('X post image generation — OpenAI returned an error:', JSON.stringify(data));
      return { imageBase64: null, error: message };
    }

    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      console.error('X post image generation — no image data in response:', JSON.stringify(data));
      return { imageBase64: null, error: 'OpenAI responded successfully but did not include image data.' };
    }
    return { imageBase64: b64, error: null };
  } catch (err) {
    console.error('X post image generation failed:', err.message);
    return { imageBase64: null, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// POST /api/x-posts/:listingId/generate   (auth required)
// ---------------------------------------------------------------------------
app.post('/api/x-posts/:listingId/generate', requireAuth, async (req, res) => {
  try {
    const listingResult = await pool.query(
      `SELECT * FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    const quota = await checkFeatureAllowed(req.customer.id, 'aiContent');
    if (!quota.allowed) {
      return res.status(403).json({ error: quota.error });
    }

    const listing = listingResult.rows[0];
    const [content, imageResult] = await Promise.all([
      generateXPostContent(listing),
      generateXPostImage(listing),
    ]);

    const result = await pool.query(
      `INSERT INTO x_posts (tracked_listing_id, content, image_base64, image_error) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.listingId, content, imageResult.imageBase64, imageResult.error]
    );

    res.json({ post: result.rows[0] });
  } catch (err) {
    console.error('generate x-post error:', err.message);
    res.status(500).json({ error: 'Could not generate a post right now.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/x-posts?trackedListingId=...   (auth required)
// ---------------------------------------------------------------------------
app.get('/api/x-posts', requireAuth, async (req, res) => {
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
      `SELECT * FROM x_posts WHERE tracked_listing_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [trackedListingId]
    );
    res.json({ posts: result.rows });
  } catch (err) {
    console.error('list x-posts error:', err.message);
    res.status(500).json({ error: 'Could not load posts' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/x-posts/:id/approve   (auth required)
// PATCH /api/x-posts/:id/reject    (auth required)
// ---------------------------------------------------------------------------
app.patch('/api/x-posts/:id/approve', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE x_posts SET status = 'approved', decided_at = now()
       WHERE id = $1 AND tracked_listing_id IN (SELECT id FROM tracked_listings WHERE customer_id = $2)
       RETURNING *`,
      [req.params.id, req.customer.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    res.json({ post: result.rows[0] });
  } catch (err) {
    console.error('approve x-post error:', err.message);
    res.status(500).json({ error: 'Could not approve post' });
  }
});

app.patch('/api/x-posts/:id/reject', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM x_posts
       WHERE id = $1 AND tracked_listing_id IN (SELECT id FROM tracked_listings WHERE customer_id = $2)
       RETURNING id`,
      [req.params.id, req.customer.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error('reject x-post error:', err.message);
    res.status(500).json({ error: 'Could not reject post' });
  }
});

// ---------------------------------------------------------------------------
// COMMUNITY POSTS (Reddit / Quora / Nextdoor) — content generation
// ---------------------------------------------------------------------------
const COMMUNITY_PLATFORMS = ['reddit', 'quora', 'nextdoor'];
const COMMUNITY_POST_TYPES = ['storytelling', 'did_you_know', 'update', 'promotion'];

const COMMUNITY_POST_TYPE_BRIEFS = {
  storytelling: 'Tell a short, genuine story — how the business started, a real customer win, or a behind-the-scenes moment. NOT a sales pitch.',
  did_you_know: 'Share one specific, useful fact or tip related to this business\'s field that most people don\'t know. Educational, not promotional.',
  update: 'Share a real, concrete update — new hours, a new product/service, something changing at the business. Informational, low-key.',
  promotion: 'A genuine offer or promotion. This is the ONLY post type allowed to be sales-focused — still keep it low-pressure and specific, not hypey.',
};

const COMMUNITY_PLATFORM_BRIEFS = {
  reddit: {
    label: 'Reddit',
    style: `Write in a casual, first-person, community-appropriate voice — like a real person posting in a relevant subreddit, not a business account. Reddit users and moderators immediately downvote or remove anything that reads like an ad. Include a short, plain title (no emojis, no clickbait) separate from the body. Never use marketing language like "check out" or "don't miss out."`,
  },
  quora: {
    label: 'Quora',
    style: `Write as a direct, helpful ANSWER to a specific, realistic question someone in this business's field would actually type into Quora. Start with a plausible question as the title, then answer it thoroughly and honestly in the body, the way a knowledgeable person (not a brand) would. Only mention the business naturally, if at all — the value is in the answer itself.`,
  },
  nextdoor: {
    label: 'Nextdoor',
    style: `Write in a warm, neighborly, local voice — like a real neighbor posting to their own neighborhood feed, not a business broadcasting an ad. Reference the local area naturally. No title needed, just the post body.`,
  },
};

async function generateCommunityPostContent(listing, platform, postType) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured.');
  }
  const platformBrief = COMMUNITY_PLATFORM_BRIEFS[platform];
  const typeBrief = COMMUNITY_POST_TYPE_BRIEFS[postType];
  const needsTitle = platform === 'reddit' || platform === 'quora';

  const prompt = `Write a single ${platformBrief.label} post for this local business:
Business name: ${listing.business_name}
Location: ${listing.location}
What they're known for / tracked keyword: ${listing.keyword}
${listing.reddit_subreddit ? `Target subreddit: r/${listing.reddit_subreddit}` : ''}
${listing.community_notes ? `Notes on brand voice / what to highlight: ${listing.community_notes}` : ''}

Post angle for this one: ${typeBrief}

Platform requirements: ${platformBrief.style}

General requirements:
- DO NOT assume the business has a physical storefront customers walk into — the business format is unknown (delivery-only, online-only, appointment-based, or storefront). Use neutral language.
- No hashtags, no emojis, no markdown formatting, no corporate/marketing tone.
- ${needsTitle ? 'Return the title on the first line, then a blank line, then the post body.' : 'Return only the post body — no title.'}
- Return ONLY the post content, nothing else — no preamble, no explanation, no quotation marks around it.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.json();
  const raw = data?.content?.map((block) => block.text || '').join(' ').trim() || '';
  if (!raw) throw new Error('AI did not return any post content.');

  if (needsTitle) {
    const parts = raw.split(/\n\s*\n/);
    const title = parts[0]?.trim() || null;
    const body = parts.slice(1).join('\n\n').trim() || raw;
    return { title, content: body };
  }
  return { title: null, content: raw };
}

// ---------------------------------------------------------------------------
// PATCH /api/tracked-listings/:id/community-profile   (auth required)
// Body: { redditSubreddit, communityNotes }
// One-time (editable) setup: which subreddit fits this business, and any
// notes on voice/what to highlight. Both optional — posts still generate
// without them, just less targeted.
// ---------------------------------------------------------------------------
app.patch('/api/tracked-listings/:id/community-profile', requireAuth, async (req, res) => {
  try {
    const { redditSubreddit, communityNotes } = req.body;

    const listingResult = await pool.query(
      `SELECT * FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.id, req.customer.id]
    );
    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    const existing = listingResult.rows[0];

    const nextSubreddit = redditSubreddit !== undefined ? (redditSubreddit.trim().replace(/^r\//i, '') || null) : existing.reddit_subreddit;
    const nextNotes = communityNotes !== undefined ? (communityNotes.trim() || null) : existing.community_notes;

    const result = await pool.query(
      `UPDATE tracked_listings SET reddit_subreddit = $1, community_notes = $2
       WHERE id = $3 AND customer_id = $4 RETURNING *`,
      [nextSubreddit, nextNotes, req.params.id, req.customer.id]
    );
    res.json({ listing: result.rows[0] });
  } catch (err) {
    console.error('set community-profile error:', err.message);
    res.status(500).json({ error: 'Could not save your community profile' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/community-posts/:listingId/generate   (auth required)
// Body: { platform: 'reddit'|'quora'|'nextdoor', postType: 'storytelling'|'did_you_know'|'update'|'promotion' }
// ---------------------------------------------------------------------------
app.post('/api/community-posts/:listingId/generate', requireAuth, async (req, res) => {
  try {
    const { platform, postType } = req.body;
    if (!COMMUNITY_PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: `platform must be one of: ${COMMUNITY_PLATFORMS.join(', ')}` });
    }
    if (!COMMUNITY_POST_TYPES.includes(postType)) {
      return res.status(400).json({ error: `postType must be one of: ${COMMUNITY_POST_TYPES.join(', ')}` });
    }

    const listingResult = await pool.query(
      `SELECT * FROM tracked_listings WHERE id = $1 AND customer_id = $2`,
      [req.params.listingId, req.customer.id]
    );
    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    const quota = await checkFeatureAllowed(req.customer.id, 'aiContent');
    if (!quota.allowed) {
      return res.status(403).json({ error: quota.error });
    }

    const listing = listingResult.rows[0];
    const { title, content } = await generateCommunityPostContent(listing, platform, postType);

    const result = await pool.query(
      `INSERT INTO community_posts (tracked_listing_id, platform, post_type, title, content) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.params.listingId, platform, postType, title, content]
    );

    res.json({ post: result.rows[0] });
  } catch (err) {
    console.error('generate community-post error:', err.message);
    res.status(500).json({ error: 'Could not generate a post right now.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/community-posts?trackedListingId=...&platform=...   (auth required)
// platform is optional — omit to get all three platforms mixed, newest first.
// ---------------------------------------------------------------------------
app.get('/api/community-posts', requireAuth, async (req, res) => {
  try {
    const { trackedListingId, platform } = req.query;
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

    const result = platform
      ? await pool.query(
          `SELECT * FROM community_posts WHERE tracked_listing_id = $1 AND platform = $2 ORDER BY created_at DESC LIMIT 10`,
          [trackedListingId, platform]
        )
      : await pool.query(
          `SELECT * FROM community_posts WHERE tracked_listing_id = $1 ORDER BY created_at DESC LIMIT 20`,
          [trackedListingId]
        );
    res.json({ posts: result.rows });
  } catch (err) {
    console.error('list community-posts error:', err.message);
    res.status(500).json({ error: 'Could not load posts' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/community-posts/:id/approve   (auth required)
// PATCH /api/community-posts/:id/reject    (auth required)
// ---------------------------------------------------------------------------
app.patch('/api/community-posts/:id/approve', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE community_posts SET status = 'approved', decided_at = now()
       WHERE id = $1 AND tracked_listing_id IN (SELECT id FROM tracked_listings WHERE customer_id = $2)
       RETURNING *`,
      [req.params.id, req.customer.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    res.json({ post: result.rows[0] });
  } catch (err) {
    console.error('approve community-post error:', err.message);
    res.status(500).json({ error: 'Could not approve post' });
  }
});

app.patch('/api/community-posts/:id/reject', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM community_posts
       WHERE id = $1 AND tracked_listing_id IN (SELECT id FROM tracked_listings WHERE customer_id = $2)
       RETURNING id`,
      [req.params.id, req.customer.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error('reject community-post error:', err.message);
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
// SCHEDULED RANK/GBP CHECKS
// Runs every day at 6am UTC, but only actually checks listings whose plan
// is due for a check that day:
//   - Watch:   once a week   (Mondays)
//   - Grow:    three times a week (Mondays, Wednesdays, Fridays)
//   - Pro: every day
// This gives each tier its own check cadence without needing separate cron
// jobs — one daily run just filters who gets checked.
// ---------------------------------------------------------------------------
async function runScheduledChecks() {
  const dayOfWeek = new Date().getUTCDay(); // 0=Sun, 1=Mon, ... 6=Sat
  console.log(`Starting scheduled rank/GBP check run (UTC day ${dayOfWeek})...`);
  try {
    const result = await pool.query(`
      SELECT tl.*, c.plan, c.email FROM tracked_listings tl
      JOIN customers c ON c.id = tl.customer_id
      WHERE c.status = 'active'
    `);

    for (const listing of result.rows) {
      const plan = listing.plan || 'watch';
      const dueToday =
        plan === 'managed' ||
        (plan === 'grow' && [1, 3, 5].includes(dayOfWeek)) ||
        (plan === 'watch' && dayOfWeek === 1);

      if (!dueToday) continue;

      try {
        const previousResult = await pool.query(
          `SELECT local_pack_position FROM rank_history WHERE tracked_listing_id = $1 ORDER BY checked_at DESC LIMIT 1`,
          [listing.id]
        );
        const previousPosition = previousResult.rows.length > 0 ? previousResult.rows[0].local_pack_position : undefined;

        // Self-heal: listings that saved a review link before this exact-
        // match improvement existed won't have google_place_id filled in
        // yet. Extract and save it now, once, so this check (and every one
        // after it) benefits automatically — no customer action needed.
        if (!listing.google_place_id && listing.review_link) {
          const backfilledPlaceId = extractPlaceIdFromReviewLink(listing.review_link);
          if (backfilledPlaceId) {
            listing.google_place_id = backfilledPlaceId;
            await pool.query(`UPDATE tracked_listings SET google_place_id = $1 WHERE id = $2`, [backfilledPlaceId, listing.id]);
          }
        }

        const rank = await runRankCheck(listing.keyword, listing.location, listing.business_name, listing.google_place_id);
        const gbp = await runGbpAudit(listing.business_name, listing.location, listing.google_place_id);

        // --- Website check (schema + keyword-in-title/meta) ---
        let websiteFindings = [];
        let websiteCheckResult = null;
        if (listing.website_url) {
          try {
            websiteCheckResult = await checkSchemaMarkup(listing.website_url, listing.keyword);
            if (websiteCheckResult.found) {
              if (!websiteCheckResult.hasLocalBusinessSchema) {
                websiteFindings.push({ severity: 'warn', type: 'missing_schema', message: 'Your website is missing LocalBusiness schema markup — a ready-to-paste fix has been generated.' });
                if (plan === 'managed') {
                  const wpResult = await applyWordPressSchemaFix(listing);
                  if (wpResult.applied) {
                    console.log(`Auto-applied schema fix via WordPress for listing ${listing.id}`);
                    await resolveManagedAutoFix(listing.id, 'missing_schema');
                  } else {
                    await queueManagedAutoFix({
                      listingId: listing.id, businessName: listing.business_name, websiteUrl: listing.website_url,
                      issueType: 'missing_schema', fixDetail: generateSchemaSnippet(listing),
                    });
                  }
                }
              } else if (plan === 'managed') {
                await resolveManagedAutoFix(listing.id, 'missing_schema');
              }
              if (!websiteCheckResult.hasKeywordInTitle) {
                websiteFindings.push({ severity: 'warn', type: 'keyword_missing_title', message: `Your tracked keyword "${listing.keyword}" doesn't appear in your homepage's title tag.` });
                if (plan === 'managed') {
                  await queueManagedAutoFix({
                    listingId: listing.id, businessName: listing.business_name, websiteUrl: listing.website_url,
                    issueType: 'keyword_missing_title', fixDetail: `Update the <title> tag to include "${listing.keyword}". Current title: "${websiteCheckResult.pageTitle}"`,
                  });
                }
              } else if (plan === 'managed') {
                await resolveManagedAutoFix(listing.id, 'keyword_missing_title');
              }
              if (!websiteCheckResult.hasKeywordInMeta) {
                websiteFindings.push({ severity: 'warn', type: 'keyword_missing_meta', message: `Your tracked keyword "${listing.keyword}" doesn't appear in your homepage's meta description.` });
                if (plan === 'managed') {
                  await queueManagedAutoFix({
                    listingId: listing.id, businessName: listing.business_name, websiteUrl: listing.website_url,
                    issueType: 'keyword_missing_meta', fixDetail: `Update the meta description to include "${listing.keyword}". Current meta: "${websiteCheckResult.metaDescription}"`,
                  });
                }
              } else if (plan === 'managed') {
                await resolveManagedAutoFix(listing.id, 'keyword_missing_meta');
              }
            }
          } catch (websiteErr) {
            console.error(`Website check failed for listing ${listing.id}:`, websiteErr.message);
          }
        }

        // --- Competitor deep-scan: top 3 competitors from the local pack ---
        const topCompetitors = (rank.localPackItems || [])
          .filter((c) => (c.title || '').toLowerCase() !== listing.business_name.toLowerCase())
          .slice(0, 3);
        const competitorDetails = [];
        for (const comp of topCompetitors) {
          try {
            const compAudit = await runGbpAudit(comp.title, listing.location);
            competitorDetails.push({
              name: comp.title,
              reviewCount: compAudit.found ? compAudit.reviewCount : null,
              rating: compAudit.found ? compAudit.rating : null,
            });
          } catch (compErr) {
            console.error(`Competitor scan failed for "${comp.title}":`, compErr.message);
          }
        }

        // Combine all findings and attach fix instructions for the report/dashboard.
        const allFindings = [
          ...(gbp.found ? [...(gbp.findings || []), ...(gbp.premiumFindings || [])] : []),
          ...websiteFindings,
        ].map((f) => ({ ...f, fix: FIX_INSTRUCTIONS[f.type] || null }));

        await pool.query(
          `INSERT INTO rank_history (tracked_listing_id, local_pack_position, review_count, rating, raw)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            listing.id,
            rank.position,
            gbp.found ? gbp.reviewCount : null,
            gbp.found ? gbp.rating : null,
            JSON.stringify({ rank: rank.localPackItems, gbp, websiteCheck: websiteCheckResult, competitorDetails, allFindings }),
          ]
        );
        console.log(`Checked listing ${listing.id} (${listing.business_name}, ${plan}) — position: ${rank.position}`);

        // Extra tracked keywords (Grow & Pro) — checked on the same
        // schedule as the listing's primary keyword, right after it.
        try {
          const extraKeywords = await pool.query(
            `SELECT * FROM tracked_keywords WHERE tracked_listing_id = $1`,
            [listing.id]
          );
          for (const tk of extraKeywords.rows) {
            try {
              const kwRank = await runRankCheck(tk.keyword, listing.location, listing.business_name, listing.google_place_id);
              await pool.query(
                `UPDATE tracked_keywords SET previous_position = local_pack_position, local_pack_position = $1, last_checked_at = now() WHERE id = $2`,
                [kwRank.position, tk.id]
              );
            } catch (kwErr) {
              console.error(`tracked-keyword check failed for "${tk.keyword}" (listing ${listing.id}):`, kwErr.message);
            }
          }
        } catch (extraKwErr) {
          console.error(`extra keyword lookup failed for listing ${listing.id}:`, extraKwErr.message);
        }

        // Review replies — Grow & Pro only. Runs on the same schedule
        // as everything else above; failures here never block the rank
        // check itself from having already saved successfully.
        if (plan === 'grow' || plan === 'managed') {
          try {
            const newReplyCount = await fetchAndDraftReviewReplies(listing);
            if (newReplyCount > 0) {
              console.log(`Drafted ${newReplyCount} new review repl${newReplyCount === 1 ? 'y' : 'ies'} for listing ${listing.id}`);
            }
          } catch (reviewErr) {
            console.error(`review-replies failed for listing ${listing.id}:`, reviewErr.message);
          }
        }

        // Instant drop alert — Grow/Pro only, fires outside the normal
        // report cadence the moment things get worse than last check.
        if ((plan === 'grow' || plan === 'managed') && previousPosition !== undefined) {
          const gotWorse =
            (previousPosition !== null && rank.position === null) ||
            (previousPosition !== null && rank.position !== null && rank.position > previousPosition);
          if (gotWorse) {
            try {
              await sendRankDropAlertEmail({
                to: listing.email,
                businessName: listing.business_name,
                previousPosition,
                newPosition: rank.position,
                dashboardUrl: `${FRONTEND_URL}/dashboard.html`,
              });
            } catch (alertErr) {
              console.error(`Drop alert email failed for listing ${listing.id}:`, alertErr.message);
            }
          }
        }

        try {
          const cadenceLabel = plan === 'managed' ? 'Daily' : plan === 'grow' ? '3x-weekly' : 'Weekly';
          await sendRankCheckReportEmail({
            to: listing.email,
            businessName: listing.business_name,
            plan,
            cadenceLabel,
            checkDateLabel: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
            position: rank.position,
            reviewCount: gbp.found ? gbp.reviewCount : null,
            rating: gbp.found ? gbp.rating : null,
            competitors: rank.localPackItems,
            competitorDetails,
            findings: allFindings,
          });
        } catch (emailErr) {
          console.error(`Report email failed for listing ${listing.id}:`, emailErr.message);
        }
      } catch (err) {
        console.error(`Scheduled check failed for listing ${listing.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Scheduled check run error:', err.message);
  }
  console.log('Scheduled rank/GBP check run complete.');
}

// Every day at 6:00 AM UTC — runScheduledChecks() decides who's actually due.
cron.schedule('0 6 * * *', runScheduledChecks);

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
// ---------------------------------------------------------------------------
// POST /api/admin/fix-customer-email?secret=...
// Body: { oldEmail, newEmail }
// One-time repair tool for exactly the bug that created it: a customer
// row whose email casing doesn't match what the (always-lowercased) login
// flow looks for. Merges the old (real, active) record onto the correct
// lowercase email — refusing to touch it if a blank duplicate already has
// real listings attached, since that would mean actual data to reconcile
// by hand instead.
// ---------------------------------------------------------------------------
app.post('/api/admin/fix-customer-email', async (req, res) => {
  if (!process.env.ADMIN_SECRET || req.query.secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const { oldEmail, newEmail } = req.body;
    if (!oldEmail || !newEmail) {
      return res.status(400).json({ error: 'oldEmail and newEmail are both required' });
    }

    const oldResult = await pool.query(`SELECT * FROM customers WHERE email = $1`, [oldEmail]);
    if (oldResult.rows.length === 0) {
      return res.status(404).json({ error: `No customer found with email exactly "${oldEmail}"` });
    }
    const targetId = oldResult.rows[0].id; // the real, paying customer — keeps this ID

    const dupResult = await pool.query(`SELECT * FROM customers WHERE email = $1`, [newEmail]);
    let migrated = null;
    if (dupResult.rows.length > 0) {
      const dupId = dupResult.rows[0].id;
      // Move any real data the duplicate accumulated over onto the real
      // account, then remove the now-empty duplicate.
      const tablesWithCustomerId = ['tracked_listings', 'review_requests', 'twilio_connections', 'resend_connections', 'support_chat_messages'];
      migrated = {};
      for (const table of tablesWithCustomerId) {
        const r = await pool.query(`UPDATE ${table} SET customer_id = $1 WHERE customer_id = $2 RETURNING id`, [targetId, dupId]);
        migrated[table] = r.rows.length;
      }
      await pool.query(`DELETE FROM customers WHERE id = $1`, [dupId]);
    }

    await pool.query(`UPDATE customers SET email = $1 WHERE id = $2`, [newEmail, targetId]);
    res.json({ fixed: true, customerId: targetId, email: newEmail, migrated });
  } catch (err) {
    console.error('fix-customer-email error:', err.message);
    res.status(500).json({ error: 'Could not fix that email' });
  }
});

app.post('/api/admin/run-checks-now', async (req, res) => {
  if (!process.env.ADMIN_SECRET || req.query.secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  runScheduledChecks(); // fire and forget — this can take a while for many listings
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

// ---------------------------------------------------------------------------
// ADMIN — Fully Managed By Us direct messages
// Lets you (not the customer) see and reply to every Fully Managed By Us
// customer's message thread from admin.html. Same ADMIN_SECRET protection
// as the other admin endpoints above.
// ---------------------------------------------------------------------------

// GET /api/admin/direct-messages?secret=...
// One row per customer (any tier) who has at least one message, most
// recently active first — the inbox list.
app.get('/api/admin/direct-messages', async (req, res) => {
  if (!process.env.ADMIN_SECRET || req.query.secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const result = await pool.query(`
      SELECT c.id AS customer_id, c.email, c.plan,
        (SELECT tl.business_name FROM tracked_listings tl WHERE tl.customer_id = c.id ORDER BY tl.created_at ASC LIMIT 1) AS business_name,
        (SELECT dm.message FROM direct_messages dm WHERE dm.customer_id = c.id ORDER BY dm.created_at DESC LIMIT 1) AS last_message,
        (SELECT dm.sender FROM direct_messages dm WHERE dm.customer_id = c.id ORDER BY dm.created_at DESC LIMIT 1) AS last_sender,
        MAX(dm.created_at) AS last_message_at,
        COUNT(dm.id) FILTER (WHERE dm.sender = 'customer') AS customer_message_count
      FROM customers c
      JOIN direct_messages dm ON dm.customer_id = c.id
      GROUP BY c.id, c.email, c.plan
      ORDER BY MAX(dm.created_at) DESC
    `);
    res.json({ threads: result.rows });
  } catch (err) {
    console.error('admin direct-messages list error:', err.message);
    res.status(500).json({ error: 'Could not load message threads.' });
  }
});

// GET /api/admin/direct-messages/:customerId?secret=...
// Full thread for one customer.
app.get('/api/admin/direct-messages/:customerId', async (req, res) => {
  if (!process.env.ADMIN_SECRET || req.query.secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const customerResult = await pool.query(
      `SELECT id, email, plan FROM customers WHERE id = $1`,
      [req.params.customerId]
    );
    if (customerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    const messagesResult = await pool.query(
      `SELECT sender, message, created_at FROM direct_messages WHERE customer_id = $1 ORDER BY created_at ASC`,
      [req.params.customerId]
    );
    res.json({ customer: customerResult.rows[0], messages: messagesResult.rows });
  } catch (err) {
    console.error('admin direct-messages thread error:', err.message);
    res.status(500).json({ error: 'Could not load this thread.' });
  }
});

// POST /api/admin/direct-messages/:customerId/reply?secret=...
// Body: { message }
// Saves your reply and emails the customer so they see it even if they're
// not actively checking the dashboard.
app.post('/api/admin/direct-messages/:customerId/reply', async (req, res) => {
  if (!process.env.ADMIN_SECRET || req.query.secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required.' });
    }

    const customerResult = await pool.query(
      `SELECT id, email FROM customers WHERE id = $1`,
      [req.params.customerId]
    );
    if (customerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    const customer = customerResult.rows[0];

    await pool.query(
      `INSERT INTO direct_messages (customer_id, sender, message) VALUES ($1, 'team', $2)`,
      [req.params.customerId, message.trim()]
    );

    if (process.env.RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.RESEND_FROM_EMAIL || 'RankHighPro <onboarding@resend.dev>',
          to: customer.email,
          subject: 'New reply from your RankHighPro team',
          html: `<p>You have a new reply from the RankHighPro team:</p><pre style="background:#f4f4f4; padding:12px; border-radius:6px; white-space:pre-wrap; font-size:13px;">${message.trim()}</pre><p>Log in to your dashboard to reply.</p>`,
        }),
      }).catch((err) => console.error('admin reply customer email error:', err.message));
    }

    res.json({ success: true });
  } catch (err) {
    console.error('admin direct-messages reply error:', err.message);
    res.status(500).json({ error: 'Could not send this reply.' });
  }
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

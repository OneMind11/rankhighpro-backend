# RankHighPro Backend

This is the "engine room" behind rankhighpro.com. It handles:
- Taking payments for the Watch/Grow/Managed plans (via Stripe)
- Running real website speed audits (via Google PageSpeed)
- Checking local pack rankings (via DataForSEO)

The landing page you already have is the storefront. This is what runs
behind the scenes when someone clicks "Start Watch" or submits the audit form.

## What you need before deploying

1. A GitHub account (free) — to hold this code so your host can find it
2. A hosting account — Railway.app is the easiest for beginners (free to start)
3. Your saved API keys:
   - Stripe secret key (`sk_test_...` for now, `sk_live_...` once you go live)
   - Stripe webhook secret (you'll get this in Step 4 below)
   - Google PageSpeed key
   - DataForSEO login + password

## Step 1: Put this code on GitHub

1. Create a free account at github.com if you don't have one
2. Create a "New repository," name it `rankhighpro-backend`
3. Upload all the files in this folder to that repository
   (GitHub's website lets you drag-and-drop files right in the browser —
   no command line needed)

## Step 2: Deploy to Railway

1. Go to railway.app, sign up (can use your GitHub login)
2. Click "New Project" → "Deploy from GitHub repo"
3. Select the `rankhighpro-backend` repo you just created
4. Railway will detect it's a Node app and start building automatically

## Step 3: Add your environment variables

In Railway, click into your project → "Variables" tab, and add each of these
(copy the names exactly, paste in your real values):

```
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
PAGESPEED_API_KEY
DATAFORSEO_LOGIN
DATAFORSEO_PASSWORD
FRONTEND_URL
```

For `STRIPE_WEBHOOK_SECRET`, leave it blank for now — you'll get this value
in Step 4.

Railway will give your app a live URL like `rankhighpro-backend-production.up.railway.app`.

## Step 4: Connect Stripe's webhook

1. In your Stripe dashboard (sandbox for now), go to Developers → Webhooks
2. Click "Add endpoint"
3. For the URL, enter: `https://YOUR-RAILWAY-URL/webhook/stripe`
4. Select these events to listen for:
   - `checkout.session.completed`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
5. Stripe will show you a "Signing secret" (starts with `whsec_`) —
   copy that into Railway's `STRIPE_WEBHOOK_SECRET` variable

## Step 5: Connect your landing page

On rankhighpro-landing.html, the "Start Watch/Grow/Managed" buttons need to
call your new backend instead of doing nothing. Replace each button's
`href="#"` with a bit of JavaScript that calls:

```
POST https://YOUR-RAILWAY-URL/api/create-checkout-session
Body: { "plan": "watch" }   (or "grow" / "managed")
```

The response gives you a `url` — redirect the browser there and Stripe
handles the rest.

I can wire this up directly in the landing page file next time we talk —
just let me know once your backend is deployed and you have your live
Railway URL.

## Testing before going live

While `STRIPE_SECRET_KEY` starts with `sk_test_`, no real money moves.
Use Stripe's test card number `4242 4242 4242 4242`, any future expiry
date, and any 3-digit CVC to simulate a real subscription signup.

## Going live later

When you're ready for real customers to pay real money:
1. Finish Stripe's business verification (the "Switch to live account" step)
2. Swap `sk_test_...` for your real `sk_live_...` key in Railway
3. Set up a new live-mode webhook (repeat Step 4 using your live dashboard)

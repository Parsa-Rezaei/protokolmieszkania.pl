# Launch & earning guide (for the owner)

Plain-English, step-by-step. Do the steps in this order. Things you type or copy are in `code`.
Everything visitors see is in Polish; this guide is in English because it is for you.

---

## Step 0 – What you have and what to expect

- A finished website (in `public/`) that works on phones and computers: the handover protocol with photos and finger signatures, the notary-fee calculator, the rental-tax calculator, verification page, FAQ, terms and privacy-policy templates.
- A small server function (`functions/api/pieczec.js`) that checks Stripe payments and stamps the PDF with a server time seal. Nobody's personal data is stored anywhere – there is no database to hack.
- It starts in **free mode** (`mode: 'free'` in `public/assets/config.js`): the full PDF is free until you switch payments on (Step 8). Free mode is a good way to get the first users and reviews.
- **Earnings:** I do not know how much you will earn. It depends on how many people find the site. Each sale is 9.99 zł minus the Stripe fee (see stripe.com/pl/pricing) and minus tax.

---

## Step 1 – Protect your accounts first (15 minutes, most important for not losing money)

Most real-world losses come from a stolen account, not from website code. Someone who gets into your GitHub or Cloudflare could replace your payment link with theirs.

1. Install an authenticator app on your phone (Google Authenticator, Microsoft Authenticator or 1Password).
2. Turn on two-factor authentication (2FA) with that app in: **GitHub**, **Cloudflare**, **Stripe**, your **e-mail** (Gmail), and the **domain registrar**.
3. Save the recovery codes on paper or in a password manager. Not in your e-mail.
4. Use a different strong password for each of these accounts.
5. Never paste a Stripe key that starts with `sk_` or `rk_`, or the seal private key, into GitHub, `config.js`, a chat or an e-mail. They go only into Cloudflare (Step 8).

---

## Step 2 – Rename the GitHub repository and set the description

I cannot rename repositories or edit descriptions with the tools I have, so do this yourself (2 minutes). Do it **before** Step 4.

1. Open the repository on github.com → **Settings** (top right of the repo) → **General**.
2. **Repository name:** `protokol-zdawczo-odbiorczy` → **Rename**. (GitHub cannot use Polish letters like ł or ę in names – that is why the current name looks broken.)
3. Same page, scroll to **Danger Zone** → **Change visibility** → **Private**. This stops competitors from copying your code. Cloudflare can still deploy from a private repo.
4. Go back to the repo main page → click the gear icon next to **About** (right side):
   - **Description:** `Generator protokołu zdawczo-odbiorczego mieszkania online: zdjęcia liczników, podpisy palcem na ekranie, PDF z SHA-256 i pieczęcią czasu. Kalkulator taksy notarialnej, PCC i ryczałtu od najmu 2026.`
   - **Website:** `https://protokolzdawczy.pl` (or your domain from Step 3)
   - **Topics:** `protokol-zdawczo-odbiorczy`, `najem`, `nieruchomosci`, `pdf`, `kalkulator`, `taksa-notarialna`, `ryczalt`, `polska`, `lodz`
5. Branch name: my work is on the branch `claude/gifted-mendel-bgmord`. Make it the main branch: **Settings → General → Default branch**. If it is not already the default, switch it. Then on the **Branches** page (repo main page → branch dropdown → *View all branches*) click the pencil icon next to that branch and rename it to `main`.
6. **Settings → Code security** (or *Advanced Security*): turn on **Dependabot alerts** and **Secret scanning** if offered.

---

## Step 3 – Choose and buy the domain

All files already use **`protokolzdawczy.pl`** (brand: *ProtokolZdawczy.pl*). I could not check whether it is free: the .pl registry lookup is blocked from my environment. Check it yourself at https://dns.pl/whois or at any registrar.

Good options, in order:
1. `protokolzdawczy.pl` – short, matches the main search phrase "protokół zdawczy".
2. `protokol-zdawczy.pl`
3. `protokolmieszkania.pl`
4. `protokolnajmu.pl`

Buy it at a Polish registrar (for example OVHcloud, home.pl, nazwa.pl, cyber_Folks). Before paying, compare the **renewal price** for year 2, not only the first-year promotion.

If you buy a **different** domain than `protokolzdawczy.pl`, the domain must be changed in 10 files. Easiest: open a new Claude Code session on this repo and write: *"Run `npm run domain -- yourdomain.pl "YourBrand.pl"`, regenerate the og image with `node scripts/make-images.mjs`, commit and push."*

---

## Step 4 – Put the site online with Cloudflare Pages (free)

1. Create a free account at https://dash.cloudflare.com (turn on 2FA – Step 1).
2. Left menu → **Workers & Pages** → **Create**. Cloudflare may show *Workers* first – choose the **Pages** tab / *"Looking to deploy Pages?"* option → **Connect to Git**.
3. Connect your GitHub account, allow access to the repository `protokol-zdawczo-odbiorczy` only.
4. Settings:
   - **Production branch:** `main`
   - **Framework preset:** `None`
   - **Build command:** leave **empty**
   - **Build output directory:** `public`
5. **Save and Deploy**. After about a minute you get an address like `https://protokol-zdawczo-odbiorczy.pages.dev`. Open it on your phone and try the whole flow.
6. From now on, every change you save in GitHub on `main` goes live automatically within about a minute.

Stay on the **free plan**. On the free plan Cloudflare stops extra requests instead of sending you a bill, so an attack cannot create costs for you.

---

## Step 5 – Connect your domain

1. Cloudflare → **Websites / Add a site** (or *Add a domain*) → type your domain → choose the **Free** plan.
2. Cloudflare shows two **nameservers** (like `xxx.ns.cloudflare.com`).
3. Log in to your registrar → your domain → **DNS servers / Serwery DNS** → replace them with the two Cloudflare nameservers. For .pl domains this can take up to 24–48 hours.
4. When Cloudflare says the domain is active: **Workers & Pages** → your project → **Custom domains** → **Set up a custom domain** → `protokolzdawczy.pl` → confirm. Add `www.protokolzdawczy.pl` as well.
5. Open `https://protokolzdawczy.pl` – it should show the site with a padlock.

---

## Step 6 – An e-mail address on your domain (free)

The site shows `kontakt@protokolzdawczy.pl` (support, complaints, leads).

1. Cloudflare → your domain → **Email** → **Email Routing** → enable.
2. Create the address `kontakt@` → forward to your Gmail → confirm the e-mail Cloudflare sends you.
3. You can now receive messages there. You reply from your Gmail.

---

## Step 7 – Legal basics in Poland (do this before taking money)

I am not a lawyer or accountant; this is a checklist of what to ask about.

1. **Business form.** Selling a digital service is a business activity. In 2026 a natural person may sell without registering a company (*działalność nierejestrowana*) if revenue in a quarter does not exceed **10 813,50 zł** (225% of the 4 806 zł minimum wage) and they did not run a registered business in the last 60 months. You then keep a simple sales record (*ewidencja sprzedaży*) and declare the income in your annual PIT. Above the limit you must register in CEIDG within 7 days.
   - If you are not a Polish/EU citizen, first ask an accountant whether your residence permit allows you to run a business in Poland.
   - Ask the accountant also about VAT exemption, issuing bills/invoices on request, and whether you need a cash register (*kasa fiskalna*) for online payments.
2. **Fill in the templates:** in GitHub open `public/regulamin.html` and `public/polityka-prywatnosci.html` (pencil icon = edit) and replace every `[ ... ]` with your real data (name, address, NIP if you have one, start date, partner list). Click **Commit changes**.
3. Have both documents checked by a lawyer if you can. Consumer-law details (withdrawal right, confirmations) matter when you sell to consumers.

---

## Step 8 – Turn on payments (Stripe, BLIK) – about 1 hour

### 8.1 Stripe account
1. Create an account at https://stripe.com (country: Poland), turn on 2FA, complete identity verification and add your bank account (PLN).
2. **Settings → Payment methods** → turn on **BLIK** (it works with PLN). Stripe protects card payments with its fraud system (Radar).
3. **Settings → Customer emails** → turn on receipts for **successful payments**.

### 8.2 Product and payment link
1. **Product catalog → Add product**: name `Pełny protokół zdawczo-odbiorczy PDF`, price `9,99 PLN`, **one-off**.
2. **Payment Links → Create** → choose that product.
   - Do **not** allow promotion codes and do **not** let customers change the quantity.
   - **After payment** → *Don't show confirmation page* → redirect to:
     `https://protokolzdawczy.pl/?platnosc={CHECKOUT_SESSION_ID}`
     (type `{CHECKOUT_SESSION_ID}` exactly like that – Stripe fills it in.)
3. Create the link. Copy two things:
   - the link itself: `https://buy.stripe.com/...`
   - its ID `plink_...` (open the link in the Stripe dashboard – the ID is in the browser address bar).

### 8.3 Stripe key with minimal rights
1. **Developers → API keys → Create restricted key**, name `pieczec`.
2. Set **Checkout Sessions → Read**. Leave everything else **None**.
3. Copy the key (`rk_live_...`). This key cannot move money or issue refunds.

### 8.4 Seal keys
1. On your computer: GitHub repo → **Code → Download ZIP** → unzip → open `tools/generator-kluczy.html` by double-clicking.
2. Click the button. You get two boxes:
   - **private key** (goes only to Cloudflare),
   - **public key** line `publicKeyJwk: { ... }` (goes to `config.js`).
3. Delete the ZIP afterwards. Never upload `generator-kluczy.html` output anywhere else.

### 8.5 Secrets in Cloudflare
Cloudflare → **Workers & Pages** → your project → **Settings** → **Variables and Secrets** (older name: *Environment variables*) → **Production** → **Add**:

| Name | Type | Value |
|---|---|---|
| `STRIPE_SECRET_KEY` | Secret | `rk_live_...` from 8.3 |
| `STRIPE_PAYMENT_LINK_ID` | Text | `plink_...` from 8.2 |
| `SEAL_PRIVATE_JWK` | Secret | the private key from 8.4 (whole line) |
| `MIN_AMOUNT_GROSZE` | Text | `999` |

Optional but recommended (limits one payment to 5 different documents):
1. **Workers & Pages → KV → Create namespace** → name `pieczecie`.
2. Project → **Settings → Bindings → Add → KV namespace** → variable name `SEAL_KV` → choose `pieczecie`.
3. Add variable `MAX_SEALS_PER_PAYMENT` (Text) = `5`.

### 8.6 Switch the website to paid mode
GitHub → `public/assets/config.js` → pencil icon → change:

```js
mode: 'stripe',
stripePaymentLink: 'https://buy.stripe.com/YOUR_LINK',
```
and replace `publicKeyJwk: null` with the public-key line from 8.4. Check `supportEmail` and `leads.email`. **Commit changes**.

Secrets are applied to new deployments only: Cloudflare → project → **Deployments** → the latest one → **Retry deployment** (or just make the commit above after adding the secrets).

### 8.7 Test before real customers
Recommended: first repeat 8.2–8.5 in Stripe **Test mode** (toggle at the top of the Stripe dashboard) with a test link, a `rk_test_...` key and an extra variable `ALLOW_TEST_PAYMENTS` = `true`. Pay with Stripe's test BLIK/card details shown in Stripe's documentation. Check that:
- you are sent back to the site and see "Płatność potwierdzona",
- the PDF contains "Pieczęć czasu serwera" and a QR code,
- scanning the QR code with a phone opens the verification page with "Pieczęć jest prawidłowa".

Then put the **live** values back and **delete** `ALLOW_TEST_PAYMENTS`. Do one real 9,99 zł payment yourself and refund it in Stripe.

---

## Step 9 – Extra protection (15 minutes)

1. Cloudflare → your domain → **Security → WAF → Rate limiting rules** → create a rule: URI path equals `/api/pieczec`, limit about 20 requests per 10 seconds per IP, action *Block*. (The free plan includes one rate-limiting rule.)
2. Stripe → **Settings → Team and security**: only you have access. **Notifications**: e-mail for disputes and payouts.
3. Look at Stripe → **Payments** once a week. Many small failed card payments in a row = someone testing stolen cards; contact Stripe support and consider leaving only BLIK on.
4. If you ever think a key leaked: Stripe → roll/delete the key, create a new one, update it in Cloudflare, retry deployment.

What cannot be prevented (honestly): the PDF is created on the customer's phone, so a programmer can change the code in their own browser and make a PDF with photos without paying. They **cannot** get a real server seal, so the verification page shows their PDF as unsealed. Normal customers will not do this.

---

## Step 10 – Get found on Google

1. https://search.google.com/search-console → **Add property → Domain** → `protokolzdawczy.pl` → Google gives a TXT record → add it in Cloudflare → **DNS → Add record → TXT** → verify.
2. Search Console → **Sitemaps** → submit `https://protokolzdawczy.pl/sitemap.xml`.
3. https://www.bing.com/webmasters → import from Google Search Console.
4. Main search phrases the page targets: *protokół zdawczo-odbiorczy mieszkania*, *protokół zdawczo-odbiorczy pdf*, *protokół zdawczo-odbiorczy online*, *generator protokołu zdawczo-odbiorczego*, *kalkulator taksy notarialnej 2026*, *ryczałt od najmu kalkulator*.
5. Note: Google shows FAQ rich results only for a few authoritative sites since 2023, so the FAQ schema mainly helps Google understand the page, not show extra stars or boxes.
6. New pages help more than anything else. Ask Claude Code to add Polish articles as separate pages, for example: "Jak spisać liczniki przy przekazaniu mieszkania", "Zwrot kaucji za mieszkanie – co zapisać w protokole", "Najem okazjonalny – dokumenty", "Koszty notarialne przy zakupie mieszkania 2026". Each article should link to the generator.
7. Optional statistics without cookies: Cloudflare project → **Metrics → Web Analytics → Enable** (the security policy already allows it).

---

## Step 11 – First users (Łódź first, then all of Poland)

1. Use it yourself once in a real apartment; take screenshots of the PDF (blur personal data) for posts.
2. Facebook groups for renting in Łódź (search: *wynajem mieszkań Łódź*, *mieszkania Łódź bez pośredników*, *wynajmujący*): read each group's rules, then post a helpful explanation ("what to write in a handover protocol so you get your deposit back") with the link. Do not spam the same post everywhere.
3. Reddit r/Polska / r/lodz, Wykop, landlord forums: answer questions about deposits and meters, link when relevant.
4. Offer free use for a month to 5–10 local property managers and estate agents in Łódź in exchange for feedback; they do handovers every week.
5. Ask happy users for a short opinion you can quote (real opinions only – never invent reviews).
6. Keep free mode for the first weeks if you need traffic; switch to `stripe` when people use it regularly.

---

## Step 12 – Second income: leads and partners

The calculators have a box "Kancelarie notarialne i eksperci kredytowi w Łodzi". Messages go to your `kontakt@` address with the user's consent text.

1. Find 2–3 **mortgage brokers / credit advisers** in Łódź (also insurance agents, moving and cleaning companies). Offer a monthly fee or a fee per lead. Put the agreement in writing.
2. Polish **notaries** follow professional-ethics rules that restrict advertising, so many will not pay for leads. Ask them, but plan your income around brokers and service companies.
3. When you have a partner, add them in `public/assets/config.js` → `partners` (example format is in the file; only `https://` links are accepted) and list them in the privacy policy (section 5).
4. Forward each lead only to the partner the person asked for, and delete leads after 12 months (that is what the privacy policy promises).
5. Search for affiliate programmes for mortgages and insurance (*program partnerski kredyt hipoteczny*) as another option.

---

## Step 13 – Weekly 20-minute routine

1. Stripe: new payments, disputes, refunds requested by e-mail.
2. `kontakt@` inbox: complaints (answer within 14 days – the terms promise this), leads.
3. Search Console: which phrases bring visitors → write the next article about them.
4. Update your *ewidencja sprzedaży* (sales record) every month.
5. Once a year: check whether notary fees, PCC or ryczałt rules changed (the calculators show 2026 rules; a draft change of notary fees was reported in July 2026). Ask Claude Code to update `public/assets/calc.js` and the texts if they change. Also move the `Expires:` date in `public/.well-known/security.txt` one year forward.

---

## How to change things later

- Payment link, price label, e-mails, partners: edit `public/assets/config.js` on github.com (pencil icon → Commit). Live in about a minute.
- Price: change it in Stripe **and** `priceLabel` in `config.js` **and** `MIN_AMOUNT_GROSZE` in Cloudflare (in grosze: 14,99 zł = `1499`) **and** the "9,99 zł" text in `public/regulamin.html`, `public/index.html` (JSON-LD `highPrice`).
- Anything bigger: open Claude Code on this repo and describe the change; ask it to run `npm test` before pushing.

---

## What was not built

The "Rainwater retention fee / Mikroretencja 2026" calculator from your idea list was not built. It is a different niche (better as a separate site and domain), and I did not verify its figures (fee rates, the 90% / 8 000 zł subsidy terms for 2026).

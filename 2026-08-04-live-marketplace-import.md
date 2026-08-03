# ONYX GROUP Live Marketplace Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the complete existing ONYX GROUP site plus an automatic exact-listing-image import system using Cloudflare Worker, R2, a browser extension, and a Safari-compatible bookmarklet.

**Architecture:** The V9.2 GitHub Pages frontend fetches live catalog data from a Worker. Import tools extract exact marketplace image URLs; the Worker copies those bytes into R2 and stores catalog/order/tracking JSON in the same bucket. Public product images therefore remain stable and same-origin to the Worker.

**Tech Stack:** HTML/CSS/vanilla JavaScript, Cloudflare Workers ES modules, Cloudflare R2, Chrome Manifest V3, Node.js built-in test runner.

## Global Constraints

- Preserve all V9.2 visual sections and existing customer-facing functions.
- Do not use random internet photos or drawn product placeholders.
- Imported product photos must originate from the selected listing and be copied automatically by the Worker.
- Telegram channel: `@onyxgrouptg`.
- Telegram administrator: `@onyxgroupadmin`.
- Email: `onyxshopmail@gmail.com`.
- Public site must remain deployable to GitHub Pages.
- Admin credentials must never be embedded in public site JavaScript.

---

### Task 1: Shared extraction and validation library

**Files:**
- Create: `shared/catalog-core.mjs`
- Test: `tests/catalog-core.test.mjs`

**Interfaces:**
- Produces: `detectPlatform(url)`, `normalizeImageUrl(url, baseUrl)`, `isSafeRemoteUrl(url)`, `mapApiProduct(raw, apiBase)`.

- [ ] Write tests for marketplace platform detection, URL normalization, private-host rejection, and public product mapping.
- [ ] Run `node --test tests/catalog-core.test.mjs` and confirm initial failure.
- [ ] Implement the shared pure functions.
- [ ] Run the tests and confirm all pass.

### Task 2: Cloudflare Worker and R2 catalog API

**Files:**
- Create: `worker/src/index.mjs`
- Create: `worker/wrangler.toml`
- Create: `worker/package.json`
- Test: `tests/worker-helpers.test.mjs`

**Interfaces:**
- Consumes: shared URL validation behavior.
- Produces: HTTP routes `/api/products`, `/api/import`, `/api/products/:id`, `/media/:key`, `/api/orders`, `/api/tracking/:code`.

- [ ] Write tests for request authorization, catalog normalization, remote image host validation, and CORS origin matching.
- [ ] Run tests and confirm failure before implementation.
- [ ] Implement R2 JSON storage helpers, image copying, catalog CRUD, order storage, and tracking routes.
- [ ] Run tests and syntax check with `node --check worker/src/index.mjs`.

### Task 3: Browser extension listing extractor

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/popup.html`
- Create: `extension/popup.css`
- Create: `extension/popup.js`
- Create: `extension/extractor.js`
- Test: `tests/extractor.test.mjs`

**Interfaces:**
- Produces: extracted payload `{sourceUrl, platform, title, description, priceText, images}` and POSTs it to `/api/import`.

- [ ] Write tests for JSON-LD extraction, OpenGraph extraction, image deduplication, and source platform detection.
- [ ] Implement extractor with marketplace-specific and generic selectors.
- [ ] Implement popup settings and import preview.
- [ ] Run Node tests and JavaScript syntax checks.

### Task 4: Public site live catalog integration

**Files:**
- Modify: `site/index.html`
- Create: `site/config.js`
- Create: `site/admin.html`
- Create: `site/admin.js`
- Create: `site/admin.css`

**Interfaces:**
- Consumes: `GET /api/products` and admin import endpoint.
- Produces: live product cards using Worker media URLs; admin bookmarklet workflow.

- [ ] Preserve the V9.2 HTML sections and replace the static catalog boot process with an API-first catalog loader.
- [ ] Update email and Telegram contacts everywhere.
- [ ] Add a non-secret API URL configuration file and visible connection status.
- [ ] Implement admin preview/import/delete UI and generated bookmarklet.
- [ ] Ensure imported calculation/order details flow into the existing individual order form.

### Task 5: Deployment scripts, documentation, and verification

**Files:**
- Create: `README.md`
- Create: `scripts/configure-site.mjs`
- Create: `scripts/smoke-check.mjs`
- Create: `package.json`

**Interfaces:**
- Produces: repeatable deployment and a distributable ZIP.

- [ ] Document Cloudflare R2 creation, Worker secret configuration, Worker deployment, GitHub Pages upload, extension installation, and bookmarklet use.
- [ ] Implement one-command site URL configuration.
- [ ] Run all Node tests, syntax checks, ID uniqueness checks, and required-section checks.
- [ ] Package final HTML, TXT copy, complete project ZIP, and extension ZIP.

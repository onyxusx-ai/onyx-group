# Marketplace and Telegram Order Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add direct Chinese marketplace search, separate calculator and individual-order flows, fast Telegram order handoff, and product source links to the ONYX GROUP site.

**Architecture:** Keep the existing static single-page frontend, add a marketplace search module that generates official marketplace search URLs, and route all managed purchase requests through a dedicated Telegram order link. Product cards expose separate “open source” and “order through ONYX” actions. Existing calculator and custom-order sections remain independent but can transfer a completed calculation into the order form.

**Tech Stack:** HTML5, CSS3, vanilla JavaScript, Node.js/Express backend already present in the project.

## Global Constraints

- Telegram public channel: `https://t.me/onyxgrouptg`.
- Telegram order manager: `https://t.me/onyxshopadmin`.
- Calculator and individual order must remain separate sections.
- Marketplace browsing must work without API keys by generating external search URLs.
- No fake claim that the site synchronizes full marketplace inventories without official APIs.
- Floating Telegram control must avoid heavy animation and filters.

---

### Task 1: Marketplace search module

**Files:**
- Modify: `index.html`

**Interfaces:**
- Produces: `MARKETPLACES`, `buildMarketplaceSearchUrl(platformId, query)`, `openMarketplaceSearch(platformId, query)`.

- [ ] Add a marketplace search section with query input and platform buttons.
- [ ] Add official marketplace metadata and URL builders.
- [ ] Add input validation and external opening behavior.
- [ ] Verify search buttons generate encoded URLs and open in a new tab.

### Task 2: Product source and ONYX order actions

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: product `sourceUrl` and `sourceSearchQuery` fields.
- Produces: `openProductSource(id)` and `startOnyxOrder(id)`.

- [ ] Add source URL metadata to every catalog product.
- [ ] Replace ambiguous product actions with “Открыть источник” and “Заказать через ONYX”.
- [ ] Prefill the individual-order form when ordering through ONYX.
- [ ] Verify both actions work independently.

### Task 3: Telegram handoff and performance

**Files:**
- Modify: `index.html`

**Interfaces:**
- Produces: `openTelegramOrder(message)` with direct-manager fallback behavior.

- [ ] Replace outdated Telegram URLs with the public channel and order manager constants.
- [ ] Remove expensive floating-button filter/animation effects.
- [ ] Use Telegram share URLs for prepared messages and provide a direct-manager fallback button.
- [ ] Add a working QR code for the order manager.

### Task 4: Separate calculator and individual order

**Files:**
- Modify: `index.html`

**Interfaces:**
- Produces: `lastCalculation`, `transferCalculationToOrder()`.

- [ ] Ensure calculator and individual-order blocks have distinct headings and layout.
- [ ] Add “Передать расчёт в заявку” below the calculator.
- [ ] Copy the complete calculation into the individual-order form only when requested.
- [ ] Verify the calculator works without opening Telegram.

### Task 5: Verification and packaging

**Files:**
- Modify: `README.md`
- Create: `tests/site-smoke.test.js`

**Interfaces:**
- Consumes: final `index.html`.

- [ ] Add static smoke tests for required sections, URLs, duplicate IDs, and JavaScript syntax.
- [ ] Run `node --test tests/site-smoke.test.js`.
- [ ] Run `node --check` against extracted inline JavaScript.
- [ ] Package HTML, TXT, and full GitHub ZIP deliverables.

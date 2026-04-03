# DFD Supply Inventory

DFD Supply Inventory is a Cloudflare Worker + D1 web application for tracking a **shared master inventory** and coordinating requests from **seven fire stations (ST01–ST07)**. It provides day-to-day workflows for supply staff (restock/issue/adjust/delete), station request intake, and usage analytics from a browser UI.  

---

## What this program does

At a high level, the app keeps one source of truth for inventory and logs every quantity change.

### Core capabilities

- **Master inventory management**
  - Create items with name, SKU, QR code, optional barcode(s), unit cost, and low-stock threshold.
  - Edit or soft-delete items when needed.
- **Inventory movement workflows**
  - **Restock** inventory into central stock.
  - **Issue** inventory to a selected station.
  - **Adjust** quantities with full transaction logging.
- **Station support**
  - Seven seeded stations (`ST01` through `ST07`).
  - Station request forms per station for supply intake and completion tracking.
- **Code lookup and scanning**
  - Lookup by SKU, barcode, QR, or additional stored barcodes.
  - Browser camera scanning via `BarcodeDetector` when available (manual entry fallback).
- **Analytics and reporting**
  - Usage grouped by item, by station, over time, and detailed transaction rows.
  - Filter by lookback days or explicit date range.
- **Admin settings and notifications**
  - Stores supply officer/admin email settings.
  - Can send request notification emails through Resend when configured.

---

## Tech stack

- **Runtime:** Cloudflare Workers
- **Database:** Cloudflare D1 (SQLite)
- **Static UI:** Vanilla HTML/CSS/JavaScript served from `public/`
- **Tooling:** Wrangler

---

## Project structure

```text
.
├─ src/
│  ├─ index.js          # Worker router (API + static assets)
│  └─ server.js         # API/business logic
├─ public/              # Front-end pages and shared JS/CSS
├─ migrations/          # D1 schema + incremental migrations
├─ wrangler.toml        # Cloudflare Pages-oriented config
├─ wrangler.worker.toml # Worker/asset binding config
└─ README.md
```

---

## Prerequisites

- Node.js 18+ (Node 20 recommended)
- npm
- Cloudflare account
- Wrangler CLI (installed via devDependencies in this repo)

---

## Setup and local development

### 1) Install dependencies

```bash
npm install
```

### 2) Authenticate Wrangler

```bash
npx wrangler login
```

### 3) Create or bind a D1 database

If you are using a fresh environment, create a DB and update `wrangler.toml` / `wrangler.worker.toml` with your new `database_id`.

```bash
npx wrangler d1 create dfd-supply
```

Then copy the returned `database_id` into both Wrangler config files.

### 4) Run migrations

Apply all SQL migrations to your local D1 instance:

```bash
npx wrangler d1 migrations apply dfd-supply --local
```

For remote/prod DB:

```bash
npx wrangler d1 migrations apply dfd-supply --remote
```

### 5) Start local dev server

```bash
npm run dev
```

Wrangler will serve the Worker and static assets together.

---

## How to use the application

After starting the app, open the local URL provided by Wrangler.

### Main pages

- `/` → Main inventory snapshot (search, low-stock shopping list, station request status)
- `/restock.html` → Restock flow
- `/issue.html` → Issue flow (assign stock to a station)
- `/inventory.html` → Inventory actions (create/edit/adjust/delete)
- `/search.html` → Search and usage analytics
- `/admin.html` → Admin settings
- `/request-ST01.html` ... `/request-ST07.html` → Station-specific request forms

### Typical workflow

1. **Add new items** in Inventory Actions.
2. **Restock** quantities as deliveries arrive.
3. **Issue** quantities to stations as supplies are distributed.
4. **Monitor low stock** from the main shopping list panel.
5. **Review analytics** and transaction history for accountability.
6. **Complete station requests** once fulfilled.

---

## API overview

All API routes are under `/api`.

- `GET /api/bootstrap` → Initial data payload (stations, items, transactions, requests, settings)
- `GET /api/analytics` → Usage analytics with filters (`days`, `stationId`, `itemId`, `search`, `startDate`, `endDate`)
- `POST /api/items` → Add item
- `PUT /api/items` → Update item
- `POST /api/items/delete` → Soft-delete item
- `POST /api/inventory/adjust` → Restock/issue adjustment transaction
- `GET /api/scan?code=...` → Resolve scanned code to item
- `POST /api/requests` → Create station request
- `POST /api/requests/complete` → Mark request(s) complete
- `GET /api/admin/settings` → Read admin settings
- `POST /api/admin/settings` → Update admin settings

---

## Environment variables (optional but recommended)

Configure secrets/vars with Wrangler for production:

- `ADMIN_KEY` (optional)
  - If set, admin settings endpoints require request header `x-admin-key: <value>`.
- `RESEND_API_KEY` (optional)
  - Enables outbound email notifications for station requests.
- `SUPPLY_FROM_EMAIL` (optional)
  - Sender address used with Resend.

Examples:

```bash
npx wrangler secret put ADMIN_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put SUPPLY_FROM_EMAIL
```

---

## Available npm scripts

```bash
npm run dev      # wrangler dev
npm run deploy   # wrangler deploy
npm run check    # syntax check for src/index.js
```

---

## Deployment

Deploy with Wrangler:

```bash
npm run deploy
```

Before first production deploy, make sure:

1. D1 database exists and `database_id` is correct.
2. Remote migrations are applied.
3. Required secrets are configured.

---

## Notes and operational considerations

- The app uses **soft delete** for items; deleted items are removed from active inventory views but preserved for audit trail purposes.
- Every inventory change writes a record in `stock_transactions` for traceability.
- Camera scanning depends on browser/device support for `BarcodeDetector` and camera permissions.
- For secure admin operations in production, set `ADMIN_KEY` and require it from trusted clients.

---

## License

No license file is currently included in this repository. Add one if you plan to distribute this project publicly.


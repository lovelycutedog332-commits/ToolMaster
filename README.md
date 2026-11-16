# ToolMaster — Public Version

A standalone, deployable tools website with user accounts and a secure,
server-side free-credit system. Built with **Node.js only — zero external
npm dependencies** (uses only `http`, `fs`, `path`, `crypto`, `url`).

## Features

- **Sign Up / Login / Logout** — full name, email, password + confirm password.
  Passwords are hashed with `crypto.scrypt` + per-user salt. Sessions use an
  httpOnly cookie.
- **Email verification** with a 6-digit code. No mail provider is connected
  yet, so the code is shown on-screen after registration and clearly labeled
  **"Simulated email delivery"** in the UI (and returned by the API) — swap in
  a real mail provider later without changing the flow.
- **Exactly 100 FREE credits, once** — every new *verified* account receives
  the configured signup bonus (default 100) exactly once. It is recorded as a
  permanent `signup_bonus` transaction with a unique reference, and repeat
  verification grants 0. Balances live only on the server (JSON database);
  the browser can never change them.
- **Paid generators (template-based, no AI key needed):** SEO Title (2),
  Hashtag (2), Caption (2), YouTube Description (3), Content Idea (3),
  AI Bio (2), Meta Description (2). Costs are editable in the admin panel.
  Credits are checked before generation, deducted **only after success**,
  and the same `referenceId` can never be charged twice. Balances never go
  negative; insufficient balance returns:
  *"Your free credits are running low. Continue using free tools or explore available credit options."*
- **Free tools (no login, no credits):** Word Counter, Case Converter,
  Percentage Calculator, Password Generator.
- **User dashboard:** welcome with name, current balance, total earned,
  total used, full transaction history, account settings, change password.
- **Admin panel:** the **first registered + verified user automatically
  becomes admin**. Admins can list users with balances, add credits, deduct
  credits with a recorded reason, view any user's transaction history, edit
  tool costs, edit the signup bonus, and suspend / unsuspend accounts.
- Forgot password + reset via code (same simulated delivery), change
  password, suspended accounts cannot log in.
- Google login is shown as a labeled placeholder ("coming soon") — it needs
  a real Google OAuth client ID to activate.

## Run locally

```bash
npm start
# open http://localhost:3000
```

Optional environment variables:

- `PORT` — port to listen on (default `3000`; hosting platforms set this).
- `DATA_DIR` — where `db.json` lives (default `./data`).

## Database

Server-side JSON file at `data/db.json` (created on first run; listed in
`.gitignore`, never commit a real one). Writes are atomic (temp file +
rename) and all mutations are serialized in-process, which prevents race
conditions and double-charging. Tables: `users`, `credits`,
`creditTransactions`, `sessions`, `toolCosts`, `settings`, `authTokens`.

## Deploy on Render (free)

1. Push this folder to a GitHub repository.
2. In Render: **New → Web Service**, connect that repository.
3. Settings:
   - **Runtime:** Node
   - **Build Command:** *(leave empty — there are no dependencies to install; `npm install` also works)*
   - **Start Command:** `npm start`
   - **Instance type:** Free
4. Render sets `PORT` automatically — the app already uses
   `process.env.PORT`.
5. A `render.yaml` is included, so you can also use **New → Blueprint** and
   Render will create the service from it.

### ⚠️ Important note about the free tier and the database

The JSON database is a file on the server's local disk. On Render's free
plan the filesystem is **ephemeral**: the database **resets on every redeploy
/ restart / spin-down**, so accounts and credit balances will be lost. For a
lasting public site, either:

- attach a **Render Persistent Disk** (paid), mount it (e.g. at
  `/opt/render/project/src/data`) and set `DATA_DIR` to that path, or
- migrate the storage layer in `server.js` to a hosted database
  (e.g. PostgreSQL / Turso) — all data access goes through the `db` object
  and the serialized `mutate()` helper, so this is a contained change.

## Project layout

```
server.js          Backend API + static file server (Node built-ins only)
public/index.html  Single-page frontend
public/styles.css  Navy (#1F1F5E) & white theme, mobile responsive
public/app.js      Frontend logic (never trusted for balances)
package.json       "start": "node server.js", engines node >= 18
render.yaml        Render service definition
data/db.json       Created on first run (git-ignored)
```

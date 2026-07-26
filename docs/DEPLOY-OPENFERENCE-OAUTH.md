# Deploying "Sign in with Openference" (OAuth provider)

This is the hand-off for shipping the OAuth authorization server that lives in the
Openference repo (`github/glm`) and pointing the packaged Deyin desktop app at it.

The provider was built, typechecked, and tested locally (9 OAuth integration tests +
the 18 pre-existing auth tests all pass). Deyin desktop is packaged and boots cleanly.
The two things only you can finish are (1) deploying glm to production and (2) running
the packaged app on Windows for the native `deyin://` round trip.

---

## 1. Important: the glm working tree is volatile

While this work was done, `github/glm` had a large number of concurrently-modified
files from another active session (200+ files: billing, admin, dashboard components,
`package.json`, Stripe scripts) plus an automated process that intermittently rewrote
identifiers. **Do not run `npm run deploy` from a dirty tree** — it builds from the
working directory and would ship all of that unrelated, unverified work to production.

Commit or stash **only the OAuth files below**, confirm `git status` is otherwise clean
(or intentionally staged), then deploy.

### OAuth files to commit (all under `github/glm`)

New files:
- `src/worker/db/migrations/0154_oauth_provider.sql`
- `src/worker/services/oauth-provider.ts`
- `src/worker/routes/oauth-provider/index.ts`
- `src/dashboard/src/pages/oauth/OAuthAuthorize.tsx`
- `src/dashboard/src/pages/oauth/OAuthComplete.tsx`
- `src/dashboard/src/pages/oauth/OAuthDevice.tsx`
- `test/oauth-provider.test.ts`

Modified files:
- `src/worker/db/schema.ts` (six `oauth*` tables appended at end)
- `src/worker/db/migrations/meta/_journal.json` (one entry for 0154)
- `src/worker/app.ts` (mounts `/oauth`, `/api/oauth`, `/.well-known` + provider routes)
- `src/worker/middleware/auth.ts` (accepts OAuth JWTs on `/v1/*`)
- `src/shared/routes.ts` (adds `ROUTES.oauth.*`)
- `src/dashboard/src/lib/postAuthRedirect.ts` (adds `setPostAuthReturnPath` + return-path resolution)
- `src/dashboard/src/PublicApp.tsx` (registers the three `/app/oauth/*` routes)

> `src/dashboard/src/components/auth/OAuthButtons.tsx` and
> `OAuthRegistrationConsent.tsx` show as modified but were **not** part of this work —
> they are concurrent changes. Review before including them.

Suggested staged commit:

```bash
cd ~/github/glm
git add \
  src/worker/db/migrations/0154_oauth_provider.sql \
  src/worker/services/oauth-provider.ts \
  src/worker/routes/oauth-provider \
  src/dashboard/src/pages/oauth \
  test/oauth-provider.test.ts \
  src/worker/db/schema.ts \
  src/worker/db/migrations/meta/_journal.json \
  src/worker/app.ts \
  src/worker/middleware/auth.ts \
  src/shared/routes.ts \
  src/dashboard/src/lib/postAuthRedirect.ts \
  src/dashboard/src/PublicApp.tsx
git commit -m "feat(oauth): Sign in with Openference authorization server"
```

---

## 2. Deploy

Wrangler is already authenticated on this machine (API token). From `github/glm`:

```bash
# Apply the OAuth tables to the production D1 (glm-proxy). 0154 is additive only.
npm run db:migrate:remote

# Build the SPA + worker and deploy (also runs the migration via predeploy chain).
npm run deploy
```

The routes in `wrangler.jsonc` already cover `openference.com`, so no new route config
is needed — the provider serves under the existing zone.

---

## 3. Post-deploy smoke checklist

```bash
# a) Discovery document (issuer must be https://openference.com)
curl -s https://openference.com/.well-known/openid-configuration | jq .

# b) JWKS (one EC/ES256 key)
curl -s https://openference.com/.well-known/jwks.json | jq .

# c) Consent page renders (open in a browser, signed in to Openference):
#    https://openference.com/app/oauth/authorize?response_type=code&client_id=deyin-desktop&redirect_uri=deyin%3A%2F%2Foauth%2Fcallback&scope=openid%20profile%20email%20model%3Ainvoke%20offline_access&state=test&code_challenge=<S256>&code_challenge_method=S256
```

Full token exchange + `/v1` acceptance are covered by `test/oauth-provider.test.ts`
(run `npm run test:workers -- oauth-provider` before deploy for a last green check).

---

## 4. Desktop app

Default issuer is already `https://openference.com` (see
`apps/desktop/src/shared/config.ts`), so once glm is live the packaged app works with no
further changes.

Linux artifacts are built at `apps/desktop/release/`:
- `deyin-0.1.0-amd64.deb` (registers the `deyin://` scheme system-wide on install)
- `deyin-0.1.0-x86_64.AppImage`

### Build the Windows installer (run on Windows, or WSL with wine)

wine is not installed here, so the `.exe` was not built. On your Windows machine:

```powershell
cd apps\desktop
pnpm --filter @deyin/desktop package -- --win
# produces apps/desktop/release/Deyin Setup 0.1.0.exe (NSIS), which registers deyin://
```

The Windows deep-link handler is wired at runtime (`app.setAsDefaultProtocolClient`) plus
single-instance argv forwarding, so after install the browser's "Open Deyin?" prompt
(like the ZCode screenshots) routes `deyin://oauth/callback` back into the app and it
signs in automatically.

---

## 5. What was verified locally

- Full authorization-code + PKCE flow against a local provider using the real
  `deyin://oauth/callback` redirect: consent -> `302 deyin://oauth/callback?code&state`
  -> token exchange returns an ES256 access token + refresh token.
- Provider integration tests: code+PKCE, replay rejection, PKCE mismatch, refresh
  rotation with family-revoke-on-reuse, consent skip, device flow, and OAuth-JWT
  acceptance on `/v1/models` (all green).
- Packaged Deyin desktop boots cleanly under WSLg; the `.deb` `.desktop` entry carries
  `MimeType=x-scheme-handler/deyin;` with `Exec=/opt/Deyin/deyin %U`.

## 6. Known limitations

- The true end-to-end desktop round trip (browser prompt -> `deyin://` -> auto sign-in)
  needs the packaged app on a real desktop OS + the deployed provider. Everything up to
  that seam is verified; it becomes testable the moment steps 2 and 4 are done.
- Email-login users sign in through Openference's existing flow; no changes were made to
  how accounts authenticate — the provider reuses the current session system.

# Google sign-in and Gmail password recovery

Google login and email recovery are separate optional integrations. Existing password login continues to work when neither is configured. Deploying this feature does not create Google credentials or authorize a Gmail sender.

## 1. Google login credentials

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create/select a project for FreeLLMAPI login.
2. Open **Google Auth Platform**. Configure **Branding** (application name, support email and developer contact) and **Audience**. Choose External if members are outside your Workspace organization. While Testing, add the intended test accounts under Test users.
3. Under **Data Access**, use only `openid` and email (`https://www.googleapis.com/auth/userinfo.email`). Members must never be asked to grant Gmail access for login.
4. Under **Clients**, create an OAuth client of type **Web application**. Add the JavaScript origin `https://freellm-thanhdo.onrender.com` and this exact **Authorized redirect URI**:

   ```text
   https://freellm-thanhdo.onrender.com/api/auth/google/callback
   ```

5. Save the Client ID and Client Secret privately. In Render → service → Environment, set:

   ```dotenv
   PUBLIC_APP_URL=https://freellm-thanhdo.onrender.com
   GOOGLE_CLIENT_ID=<login-client-id>
   GOOGLE_CLIENT_SECRET=<login-client-secret>
   ```

`PUBLIC_APP_URL` is a canonical origin, without a path, query, credentials or fragment. HTTPS is required except on localhost. For development, register a separate callback such as `http://localhost:3001/api/auth/google/callback`; the callback must reach the server. Proxy `/api` correctly if the UI uses a separate development port.

Existing accounts with Google-authoritative verified Gmail or Workspace emails can sign in to the same account and keep their role. Identity is subsequently bound by Google's `sub`, not by email. Other Google email domains cannot claim an existing password account through email matching alone. New accounts need a valid invitation and are always members. Google signup displays the initial personal key once before opening the dashboard.

Sources: [OIDC server flow](https://developers.google.com/identity/openid-connect/openid-connect), [ID-token validation and authoritative email](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).

## 2. Authorize one Gmail sender

Render Free [blocks SMTP ports 25, 465 and 587](https://render.com/docs/free). This implementation uses Gmail's HTTPS API; Gmail App Passwords are not used.

Prefer a **separate Google Cloud project and OAuth client** for the sender. This keeps the sensitive Gmail scope out of the basic login project's consent configuration.

1. In the sender project, enable **Gmail API** under APIs & Services → Library.
2. Configure Branding/Audience. For initial testing, add only the sending Gmail account as a test user. Add the single scope `https://www.googleapis.com/auth/gmail.send` under Data Access. Do not request mailbox read/modify scopes.
3. Create another **Web application** OAuth client. For the one-time sender setup, register `https://developers.google.com/oauthplayground` as an authorized redirect URI.
4. Open [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/). In its settings, enable **Use your own OAuth credentials**, enter the sender client's ID/secret, use the server-side flow and request offline access. These are Google's pages; never paste these values into a public issue or chat.
5. Select/enter only `https://www.googleapis.com/auth/gmail.send`. Authorize using the Gmail account that will send recovery emails. Exchange the authorization code for tokens and privately save the **refresh token**. If it is absent, reauthorize with the consent prompt after checking the offline setting.
6. Put these variables into Render Environment:

   ```dotenv
   GMAIL_CLIENT_ID=<sender-client-id>
   GMAIL_CLIENT_SECRET=<sender-client-secret>
   GMAIL_REFRESH_TOKEN=<sender-refresh-token>
   GMAIL_SENDER=<the-authorized-sender@gmail.com>
   ```

Use the authorized Gmail address as `GMAIL_SENDER`. An arbitrary unverified From address is not supported. Google login's client and the sender's client are distinct; never put a member's refresh token here.

**Testing-mode limitation:** refresh tokens issued by an External app in Testing with Gmail scopes expire after seven days. This is suitable for a trial, not unattended production recovery. Review Google's production audience and verification requirements before relying on the sender long term. Publishing and verification are separate; personal-use exceptions may apply, but publishing alone does not guarantee token permanence or delivery. Any token can later be revoked.

Sources: [OAuth Playground with your own credentials](https://developer.chrome.com/docs/webstore/using-api), [Gmail sending](https://developers.google.com/workspace/gmail/api/guides/sending), [Gmail scope classifications](https://developers.google.com/workspace/gmail/api/auth/scopes), [OAuth token expiration](https://developers.google.com/identity/protocols/oauth2), [verification exceptions](https://support.google.com/cloud/answer/13464323?hl=en).

## 3. Deploy and validate

Save environment changes and deploy. Preserve the existing `ENCRYPTION_KEY`, Turso settings and admin credentials. Never generate a replacement encryption key as part of OAuth setup.

1. `GET /api/auth/methods` should show the intended `googleEnabled` and `emailResetEnabled` flags. It does not expose configuration values. Flags indicate configuration presence, not a successful live Google authorization test.
2. Sign in with an existing Google account and check its role. Test a new member via an invitation link; verify that its initial key can be copied once.
3. Use Forgot password, enter a member email, and check Inbox/Spam. The response deliberately does not confirm whether the email is registered.
4. Open the email link, enter matching new passwords, then sign in normally. Prior sessions belonging to that user are revoked. Other accounts and provider keys are unaffected.
5. Confirm that reusing the link fails. Request a new link if it expires. A new request supersedes earlier links; changing the account email/password invalidates outstanding links.

Recovery messages are dispatched after the generic HTTP acknowledgement. If the process stops or Gmail rejects delivery, the user may need to retry. Failed delivery removes that token and records only a constant, redacted error. There is no durable email retry queue in this version.

## Security and compatibility

- Google code flow uses PKCE S256, state, nonce, verified Google signatures/issuer/audience/expiry, and an encrypted HttpOnly browser-bound attempt cookie.
- Redirects contain no dashboard session or personal API key. A short-lived HttpOnly cookie redeems an encrypted, single-use result. These temporary database rows are excluded from plaintext credentials and purged on expiration during subsequent auth operations.
- Reset links contain a random 256-bit token in a URL fragment, which is not sent in HTTP requests. The UI clears that fragment after capture. Database storage contains only a hash and an account fingerprint. Links expire in 15 minutes and can be consumed once.
- Per-address and source request limits protect delivery; repeated addresses get the same public acknowledgement. A source limit may return 429.
- With `PUBLIC_APP_URL` configured, the old global console-code recovery endpoints return 410. Recovery requires the account-specific email flow. Without it, local/desktop console recovery remains compatible.
- Provider keys, gateway keys, `/v1/*`, `/livez`, `/readyz` and `/api/ping` retain their existing behavior.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Google button absent | All login environment variables, canonical URL, and latest deploy |
| `redirect_uri_mismatch` | Exact callback spelling, HTTPS, host, port and absence of trailing slash |
| Consent denied or callback failed | Test-user list, valid invitation for new accounts, cookie support; restart the flow |
| Existing account cannot link | Non-authoritative email or a different Google subject already linked; do not bypass the identity check |
| Recovery unavailable | Sender variables and canonical URL |
| Generic success but no email | Spam, sender account, Gmail API enablement, matching sender client/refresh token, scope, expiry/revocation and Google quotas |
| Reset link invalid | Expiry, a newer request, previous use, or email/password changed since issuance |

Keep all secrets in Render Environment or a private local `.env` outside Git. The repository's `.env.example` contains only variable names. Do not attach real `.env` files, Google token responses or full reset links to bug reports.

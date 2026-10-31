# External auth API
All responses use Cache-Control: no-store.
- GET /api/auth/methods → {googleEnabled, emailResetEnabled, legacyResetAllowed}; no configuration secrets.
- POST /api/auth/google/start {inviteCode?} → {url}; sets encrypted HttpOnly SameSite=Lax attempt cookie. Fixed Google origin.
- GET /api/auth/google/callback?code=...&state=... → canonical /?auth=google and an HttpOnly one-time result cookie, or /?auth_error=google_failed. No token in redirect.
- POST /api/auth/google/complete → {token,email,role,apiKey?}; requires the cookie, consumes once, deletes cookie.
- POST /api/auth/email/forgot-password {email} → {success:true,message}; same acknowledgement for unknown and throttled addresses; source abuse may return 429. Delivery runs after response; failures never reveal account existence.
- POST /api/auth/email/reset-password {token,newPassword} → {success:true}; minimum 8, maximum 128 password chars; invalid/expired/reused link → 400; no automatic login.
- Hosted mode with PUBLIC_APP_URL blocks old global console /forgot-password and /reset-password with 410. Local and desktop mode preserve them.
Reset links: canonical root URL with #reset_token=...; fragments are not sent in HTTP requests. Browser erases fragment on capture.

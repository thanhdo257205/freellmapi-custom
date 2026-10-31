# Validation
1. Run `npm ci`, `npm run test:migrations`, targeted external-auth server and client tests, `npm run lint`, `npm run build`, then `npm test`.
2. Configure a localhost canonical URL and test credentials using the operator guide in docs/en/auth/04-google-login-and-email-recovery.md.
3. With no configuration, verify password login and local console recovery still work.
4. With configuration, sign in an existing account with Google, then sign up a new Google account with an invite. Check role and initial key display; replay the callback/result and confirm rejection.
5. Request member recovery to Gmail. Open link, choose password, verify normal login and revocation of old sessions; verify another user remains unchanged. Test expiry and reuse.
6. Never paste tokens or sender credentials into test reports. Actual Google/Gmail integration awaits operator-supplied credentials.

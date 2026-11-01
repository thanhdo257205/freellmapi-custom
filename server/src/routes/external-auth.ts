import { Router, type Request } from 'express';
import { z } from 'zod';
import type { ExternalAuthMethods } from '@freellmapi/shared/external-auth.js';
import { getExternalAuthConfig } from '../services/external-auth-config.js';
import { allowAuthRequest } from '../services/auth-security.js';
import { startGoogleFlow, takeGoogleAttempt, exchangeGoogleCode, finishGoogleLogin, consumeGoogleHandoff } from '../services/google-auth.js';
import { requestEmailReset, completeEmailReset } from '../services/email-recovery.js';

export const externalAuthRouter = Router();
const ATTEMPT_COOKIE = 'flm_google_attempt';
const RESULT_COOKIE = 'flm_google_result';
const cookieOptions = () => ({ httpOnly: true, sameSite: 'lax' as const,
  secure: getExternalAuthConfig().publicUrl?.startsWith('https:') ?? false, path: '/api/auth/google' });
function cookie(req: Request, name: string): string {
  const item = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(name + '='));
  return item ? item.slice(name.length + 1) : '';
}
function sameOrigin(req: Request): boolean {
  const origin = req.get('Origin');
  return req.get('Sec-Fetch-Site') !== 'cross-site' && (!origin || origin === getExternalAuthConfig().publicUrl);
}
const error = (message: string, type: string) => ({ error: { message, type } });

externalAuthRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); next(); });
externalAuthRouter.get('/methods', (_req, res) => {
  const config = getExternalAuthConfig();
  const methods: ExternalAuthMethods = { googleEnabled: !!config.google, emailResetEnabled: !!config.gmail, legacyResetAllowed: config.legacyResetAllowed };
  res.json(methods);
});
externalAuthRouter.post('/google/start', (req, res) => {
  const config = getExternalAuthConfig().google;
  if (!config) { res.status(503).json(error('Google sign-in is not configured.', 'not_configured')); return; }
  if (!sameOrigin(req)) { res.status(403).json(error('Invalid request origin.', 'forbidden')); return; }
  if (!allowAuthRequest('google:' + req.ip, 30)) { res.status(429).json(error('Try again later.', 'rate_limit_error')); return; }
  const parsed = z.object({ inviteCode: z.string().trim().max(128).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json(error('Invalid invite code.', 'invalid_request')); return; }
  try {
    const flow = startGoogleFlow(config, parsed.data.inviteCode);
    res.cookie(ATTEMPT_COOKIE, flow.cookie, { ...cookieOptions(), maxAge: 10 * 60 * 1000 });
    res.json({ url: flow.url });
  } catch { res.status(400).json(error('Complete account setup before Google sign-in.', 'setup_required')); }
});
externalAuthRouter.get('/google/callback', async (req, res) => {
  const config = getExternalAuthConfig().google;
  if (!config) { res.status(503).json(error('Google sign-in is not configured.', 'not_configured')); return; }
  res.clearCookie(ATTEMPT_COOKIE, cookieOptions());
  try {
    const state = z.string().length(43).parse(req.query.state);
    const attempt = takeGoogleAttempt(cookie(req, ATTEMPT_COOKIE), state);
    if (req.query.error) throw new Error('Google consent cancelled');
    const code = z.string().min(1).max(4096).parse(req.query.code);
    const identity = await exchangeGoogleCode(code, attempt, config);
    const ticket = finishGoogleLogin(identity, attempt.inviteCode);
    res.cookie(RESULT_COOKIE, ticket, { ...cookieOptions(), maxAge: 2 * 60 * 1000 });
    res.redirect(config.publicUrl + '/?auth=google');
  } catch {
    res.clearCookie(RESULT_COOKIE, cookieOptions());
    res.redirect(config.publicUrl + '/?auth_error=google_failed');
  }
});
externalAuthRouter.post('/google/complete', (req, res) => {
  if (!sameOrigin(req)) { res.status(403).json(error('Invalid request origin.', 'forbidden')); return; }
  res.clearCookie(RESULT_COOKIE, cookieOptions());
  const result = consumeGoogleHandoff(cookie(req, RESULT_COOKIE));
  if (!result) { res.status(400).json(error('Google sign-in expired. Please try again.', 'invalid_handoff')); return; }
  res.json(result);
});
externalAuthRouter.post('/email/forgot-password', (req, res) => {
  if (!getExternalAuthConfig().gmail) { res.status(503).json(error('Email recovery is not configured.', 'not_configured')); return; }
  if (!sameOrigin(req)) { res.status(403).json(error('Invalid request origin.', 'forbidden')); return; }
  const parsed = z.object({ email: z.string().trim().email().max(254) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json(error('A valid email is required.', 'invalid_request')); return; }
  if (!allowAuthRequest('recovery-ip:' + req.ip, 10)) {
    res.setHeader('Retry-After', '900'); res.status(429).json(error('Too many recovery requests. Try again later.', 'rate_limit_error')); return;
  }
  const permitted = allowAuthRequest('recovery-email:' + parsed.data.email.toLowerCase(), 3);
  // Same acknowledgement/timing for all accounts: SMTP/API delivery is never awaited here.
  res.json({ success: true, message: 'If an account exists, a password reset link will be sent to that email.' });
  if (permitted) setImmediate(() => { void requestEmailReset(parsed.data.email).catch(() => {
    // Never log Google SDK errors, email addresses, reset links or credentials.
    console.error('[email-recovery] Delivery failed; check sender configuration.');
  }); });
});
externalAuthRouter.post('/email/reset-password', (req, res) => {
  if (!getExternalAuthConfig().gmail) { res.status(503).json(error('Email recovery is not configured.', 'not_configured')); return; }
  if (!sameOrigin(req)) { res.status(403).json(error('Invalid request origin.', 'forbidden')); return; }
  if (!allowAuthRequest('reset-ip:' + req.ip, 30)) { res.status(429).json(error('Try again later.', 'rate_limit_error')); return; }
  const parsed = z.object({ token: z.string().max(128), newPassword: z.string().min(8).max(128) }).safeParse(req.body);
  if (!parsed.success || !completeEmailReset(parsed.data.token, parsed.data.newPassword)) {
    res.status(400).json(error('This reset link is invalid or expired. Request a new one.', 'invalid_reset_token')); return;
  }
  res.json({ success: true });
});
externalAuthRouter.post(['/forgot-password', '/reset-password'], (_req, res, next) => {
  if (getExternalAuthConfig().legacyResetAllowed) { next(); return; }
  res.status(410).json(error('Use email password recovery for this hosted deployment.', 'email_recovery_required'));
});

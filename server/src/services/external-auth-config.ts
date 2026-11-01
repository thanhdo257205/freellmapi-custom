import { z } from 'zod';

export interface GoogleAuthConfig { clientId: string; clientSecret: string; publicUrl: string; redirectUri: string }
export interface GmailConfig { clientId: string; clientSecret: string; refreshToken: string; sender: string; publicUrl: string }
const env = (name: string) => process.env[name]?.trim() || '';

export function getExternalAuthConfig() {
  let publicUrl: string | null = null;
  try {
    const url = new URL(env('PUBLIC_APP_URL'));
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol === 'https:' || (url.protocol === 'http:' && local)) &&
        !url.username && !url.password && !url.search && !url.hash && url.pathname === '/') publicUrl = url.origin;
  } catch { /* Unconfigured integrations stay disabled. Never echo env values. */ }
  const clientId = env('GOOGLE_CLIENT_ID');
  const clientSecret = env('GOOGLE_CLIENT_SECRET');
  const google: GoogleAuthConfig | null = publicUrl && clientId && clientSecret
    ? { clientId, clientSecret, publicUrl, redirectUri: publicUrl + '/api/auth/google/callback' } : null;
  const mailId = env('GMAIL_CLIENT_ID');
  const mailSecret = env('GMAIL_CLIENT_SECRET');
  const refreshToken = env('GMAIL_REFRESH_TOKEN');
  const sender = env('GMAIL_SENDER');
  const gmail: GmailConfig | null = publicUrl && mailId && mailSecret && refreshToken && z.string().email().safeParse(sender).success && !/[\r\n]/.test(sender)
    ? { clientId: mailId, clientSecret: mailSecret, refreshToken, sender, publicUrl } : null;
  return { publicUrl, google, gmail, legacyResetAllowed: !env('PUBLIC_APP_URL') || process.env.FREEAPI_DESKTOP === '1' };
}

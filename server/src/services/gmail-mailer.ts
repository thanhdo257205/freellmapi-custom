import { z } from 'zod';
import { getExternalAuthConfig } from './external-auth-config.js';

/** Gmail REST over HTTPS: no SMTP ports, member mailbox scopes or email SDK logs. */
export async function sendPasswordResetEmail(recipient: string, resetUrl: string): Promise<void> {
  const config = getExternalAuthConfig().gmail;
  if (!config) throw new Error('Email recovery is not configured');
  if (!z.string().email().safeParse(recipient).success || /[\r\n]/.test(recipient)) throw new Error('Invalid recipient');
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
      refresh_token: config.refreshToken, grant_type: 'refresh_token' }),
  });
  if (!tokenResponse.ok) throw new Error('Gmail sender authorization failed');
  const credentials = await tokenResponse.json() as { access_token?: string };
  if (!credentials.access_token) throw new Error('Gmail sender authorization failed');
  const body = [
    'A password reset was requested for your FreeLLMAPI account.', '',
    'Open this link to choose a new password (expires in 15 minutes):', resetUrl, '',
    'If you did not request this, ignore this email. Your password has not changed.',
  ].join('\r\n');
  const mime = [
    `From: ${config.sender}`, `To: ${recipient}`, 'Subject: Reset your FreeLLMAPI password',
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
    '', Buffer.from(body).toString('base64').match(/.{1,76}/g)!.join('\r\n'),
  ].join('\r\n');
  const result = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${credentials.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: Buffer.from(mime).toString('base64url') }),
  });
  if (!result.ok) throw new Error('Gmail delivery failed');
}

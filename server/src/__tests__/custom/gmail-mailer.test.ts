import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sendPasswordResetEmail } from '../../services/gmail-mailer.js';
beforeEach(() => {
  for (const [key, value] of Object.entries({
    PUBLIC_APP_URL: 'https://app.example.com',
    GMAIL_CLIENT_ID: 'sender-client',
    GMAIL_CLIENT_SECRET: 'sender-secret',
    GMAIL_REFRESH_TOKEN: 'sender-refresh',
    GMAIL_SENDER: 'sender@gmail.com',
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('refreshes the sender credential and sends a safe MIME message over Gmail HTTPS', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify(
          calls.length === 1
            ? { access_token: 'transient-access' }
            : { id: 'message-id' },
        ),
      );
    }),
  );
  await sendPasswordResetEmail(
    'member@gmail.com',
    'https://app.example.com/#reset_token=one-time',
  );
  expect(calls.map((call) => call.url)).toEqual([
    'https://oauth2.googleapis.com/token',
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
  ]);
  expect(
    new URLSearchParams(calls[0].init.body as URLSearchParams).get(
      'grant_type',
    ),
  ).toBe('refresh_token');
  const mime = Buffer.from(
    JSON.parse(String(calls[1].init.body)).raw,
    'base64url',
  ).toString();
  expect(mime).toContain('To: member@gmail.com\r\n');
  const body = Buffer.from(
    mime.split('\r\n\r\n')[1].replace(/\r\n/g, ''),
    'base64',
  ).toString();
  expect(body).toContain('https://app.example.com/#reset_token=one-time');
  expect(mime).not.toContain('sender-secret');
  expect(mime).not.toContain('sender-refresh');
});

it('rejects header injection before any network request', async () => {
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  await expect(
    sendPasswordResetEmail(
      'victim@gmail.com\r\nBcc: attacker@example.com',
      'https://app.example.com',
    ),
  ).rejects.toThrow('Invalid recipient');
  expect(network).not.toHaveBeenCalled();
});

it('does not include Google error responses or credentials in errors', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response('private Google error details', { status: 401 }),
    ),
  );
  await expect(
    sendPasswordResetEmail('member@gmail.com', 'https://app.example.com'),
  ).rejects.toThrow('Gmail sender authorization failed');
});

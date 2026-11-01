import { z } from 'zod';
import { getDb } from '../db/index.js';
import { getExternalAuthConfig } from './external-auth-config.js';

/**
 * Sends notification emails via Gmail HTTPS REST API when configured.
 * Safely ignores errors / unconfigured states so auth flows are never blocked.
 */
async function sendRawGmail(to: string, subject: string, bodyText: string): Promise<boolean> {
  const config = getExternalAuthConfig().gmail;
  if (!config) return false;
  if (!z.string().email().safeParse(to).success || /[\r\n]/.test(to)) return false;

  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!tokenResponse.ok) return false;
    const credentials = (await tokenResponse.json()) as { access_token?: string };
    if (!credentials.access_token) return false;

    const mime = [
      `From: ${config.sender}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(bodyText).toString('base64').match(/.{1,76}/g)!.join('\r\n'),
    ].join('\r\n');

    const result = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${credentials.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: Buffer.from(mime).toString('base64url') }),
    });

    return result.ok;
  } catch {
    // Delivery failure should not break user registration or admin workflow
    return false;
  }
}

/**
 * Notify the system admin when a new user requests account registration.
 */
export async function notifyAdminNewRegistration(requestEmail: string, note: string | null): Promise<void> {
  const config = getExternalAuthConfig();
  const db = getDb();

  // Find admin email (first user with role = admin, or fallback to sender)
  const adminRow = db.prepare("SELECT email FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get() as { email: string } | undefined;
  const adminEmail = adminRow?.email || config.gmail?.sender;
  if (!adminEmail) return;

  const appUrl = config.publicUrl || 'https://freellm-thanhdo.onrender.com';
  const subject = `[FreeLLMAPI] Yêu cầu đăng ký mới: ${requestEmail}`;
  const body = [
    `Xin chào Admin,`,
    ``,
    `Hệ thống vừa nhận được yêu cầu đăng ký tài khoản mới:`,
    `- Email đăng ký: ${requestEmail}`,
    `- Lời nhắn: ${note?.trim() || '(Không có lời nhắn)'}`,
    `- Thời gian: ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`,
    ``,
    `Bạn có thể đăng nhập vào trang Quản lý Người dùng để Duyệt hoặc Từ chối:`,
    `${appUrl}/users`,
    ``,
    `Trân trọng,`,
    `FreeLLMAPI Notification System`,
  ].join('\r\n');

  await sendRawGmail(adminEmail, subject, body);
}

/**
 * Notify user that their account registration request has been approved.
 */
export async function notifyUserRegistrationApproved(userEmail: string): Promise<void> {
  const config = getExternalAuthConfig();
  const appUrl = config.publicUrl || 'https://freellm-thanhdo.onrender.com';
  const subject = `[FreeLLMAPI] Tài khoản của bạn đã được kích hoạt thành công`;
  const body = [
    `Xin chào,`,
    ``,
    `Yêu cầu đăng ký tài khoản của bạn (${userEmail}) tại FreeLLMAPI đã được Admin phê duyệt!`,
    ``,
    `Bạn có thể đăng nhập ngay bằng mật khẩu bạn đã tạo lúc gửi yêu cầu:`,
    `${appUrl}`,
    ``,
    `Sau khi đăng nhập:`,
    `1. Vào trang API Keys để copy khóa API cá nhân (dạng sk-flm-...).`,
    `2. Kết nối với Cursor / Cline / Roo Code qua endpoint Base URL: ${appUrl}/v1`,
    ``,
    `Chúc bạn có trải nghiệm làm việc hiệu quả cùng FreeLLMAPI!`,
    ``,
    `Trân trọng,`,
    `FreeLLMAPI Team`,
  ].join('\r\n');

  await sendRawGmail(userEmail, subject, body);
}

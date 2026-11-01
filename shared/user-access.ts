/** Public multi-user API contracts. Never include plaintext secrets in list DTOs. */

export const SYSTEM_PERMISSIONS = [
  'manage_keys',
  'manage_users',
  'manage_invites',
  'manage_requests',
  'manage_settings',
  'manage_backups',
  'view_logs',
] as const;

export type Permission = typeof SYSTEM_PERMISSIONS[number] | '*';

export interface UserSession {
  userId: number
  email: string
  role: 'admin' | 'member'
  isPrimary?: boolean
  permissions?: Permission[]
}

export interface UserApiKey {
  id: number
  userId: number
  name: string
  keyPrefix: string
  rpmLimit: number
  revoked: boolean
  createdAt: string
  lastUsedAt: string | null
}

export interface AdminUser {
  id: number
  email: string
  role: 'admin' | 'member'
  isPrimary: boolean
  permissions: Permission[]
  createdAt: string
  /** Non-revoked `sk-flm-…` keys this account can still authenticate with. */
  activeKeys: number
  /** Unexpired dashboard sessions. */
  sessions: number
  /** True for the caller's own row — the UI disables self-demote and warns on self-revoke. */
  isSelf: boolean
}

export interface InviteCode {
  id: number
  code: string
  createdBy: number
  creatorEmail: string
  maxUses: number
  usedCount: number
  expiresAtMs: number | null
  note: string | null
  revoked: boolean
  status: 'active' | 'exhausted' | 'expired' | 'revoked'
  createdAt: string
}

export interface RegistrationRequest {
  id: number
  email: string
  note: string | null
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
  reviewedAt: string | null
}


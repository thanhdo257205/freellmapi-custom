/** Public multi-user API contracts. Never include plaintext secrets in list DTOs. */
export interface UserSession {
  userId: number
  email: string
  role: 'admin' | 'member'
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

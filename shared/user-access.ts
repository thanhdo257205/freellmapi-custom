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

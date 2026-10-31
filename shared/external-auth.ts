export interface ExternalAuthMethods {
  googleEnabled: boolean
  emailResetEnabled: boolean
  legacyResetAllowed: boolean
}
export interface ExternalAuthResult {
  token: string
  email: string
  role: 'admin' | 'member'
  apiKey?: string
}

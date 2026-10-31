import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { apiFetch, setToken, UNAUTHORIZED_EVENT, type ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field-error'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'
import { Label } from '@/components/ui/label'
import { isEmail } from '@/lib/validate'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import { useSessionBoundary } from '@/custom/session-state'
import { RegistrationKeyNotice } from '@/custom/RegistrationKeyNotice'
import { GoogleSignInButton } from '@/custom/GoogleSignInButton'
import { EmailRecoveryForm } from '@/custom/EmailRecoveryForm'
import { ResetPasswordForm } from '@/custom/ResetPasswordForm'
import type { ExternalAuthMethods } from '../../../shared/external-auth'

// Matches the server rule (routes/auth.ts zod schema).
const PASSWORD_MIN = 8

// Inside the desktop shell the dashboard runs as a hidden machine account with
// a random password nobody knows (desktop/src/server-host.ts). There are no
// credentials to type, so the gate never shows a login form there: when the
// seeded session is gone (expired after a month of uptime, or cleared by a
// 401) it asks the shell for a fresh one through the preload bridge.
type DesktopWindow = Window & {
  __FREEAPI_DESKTOP__?: boolean
  __FREEAPI_SESSION__?: () => Promise<string>
}
function desktopSessionBridge(): (() => Promise<string>) | null {
  if (typeof window === 'undefined') return null
  const w = window as DesktopWindow
  return w.__FREEAPI_DESKTOP__ === true && typeof w.__FREEAPI_SESSION__ === 'function'
    ? w.__FREEAPI_SESSION__
    : null
}

// The same dashboard opened in a normal browser tab on a desktop install has no
// preload bridge, so the server mints the session instead (#1399). It only
// does so for a request from this computer, and says so through `desktop` on
// /api/auth/status; web and Docker installs never set it and keep their login.
async function browserDesktopSession(): Promise<string> {
  const res = await apiFetch<{ token: string }>('/api/auth/desktop-session', { method: 'POST' })
  return res.token
}

interface AuthStatus {
  needsSetup: boolean
  authenticated: boolean
  email: string | null
  desktop?: boolean
}

function Centered({ children }: { children: ReactNode }) {
  // dvh, not vh: on mobile the collapsing URL bar and the software keyboard both
  // change the viewport, and 100vh leaves the card parked mid-scroll.
  return (
    <main className="min-h-dvh flex items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">{children}</div>
    </main>
  )
}

function AuthForm({ mode, onAuthed, externalError }: { mode: 'setup' | 'login'; onAuthed: () => void; externalError?: string | null }) {
  const { t } = useI18n()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [setupCode, setSetupCode] = useState('')
  // Revealed only after the server asks for it (remote first-run setup). A
  // browser on the same machine as the server never sees this field.
  const [codeRequired, setCodeRequired] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [showForgot, setShowForgot] = useState(false)
  const [useLegacyForgot, setUseLegacyForgot] = useState(false)
  const { data: methods } = useQuery<ExternalAuthMethods>({
    queryKey: ['auth-methods'],
    queryFn: () => apiFetch('/api/auth/methods'),
    staleTime: 60 * 1000,
  })
  const [registration, setRegistration] = useState<{ token: string; apiKey: string } | null>(null)

  // URL query parameter support: ?invite=... or ?mode=register defaults to registration
  const [inviteParam] = useState(() => {
    if (typeof window === 'undefined') return ''
    const params = new URLSearchParams(window.location.search)
    return params.get('invite') || ''
  })
  const [registerParam] = useState(() => {
    if (typeof window === 'undefined') return false
    const params = new URLSearchParams(window.location.search)
    return params.get('mode') === 'register' || !!params.get('invite')
  })

  const [authView, setAuthView] = useState<'login' | 'register'>(registerParam ? 'register' : 'login')
  const [inviteCode, setInviteCode] = useState(inviteParam)

  const isSetup = mode === 'setup'
  const isRegister = !isSetup && authView === 'register'
  const isLogin = !isSetup && authView === 'login'

  // Inline field feedback; the server stays authoritative. Only the setup form
  // enforces the password minimum client-side (an existing password of any
  // length must still be able to log in). The same goes for the email shape:
  // the desktop app's hidden account is `desktop@localhost` (no TLD), which
  // the login route accepts on purpose (server/src/routes/auth.ts), so a
  // browser tab must be able to submit it after a password reset (#1250).
  const inviteError = isRegister && !inviteCode.trim() ? 'Invite code is required' : null
  const emailError = !email.trim()
    ? t('validation.required')
    : (isSetup || isRegister) && !isEmail(email)
      ? t('validation.email')
      : null
  const passwordError = !password
    ? t('validation.required')
    : (isSetup || isRegister) && password.length < PASSWORD_MIN
      ? t('validation.passwordMin', { min: PASSWORD_MIN })
      : null

  const showInviteError = attempted && !!inviteError
  const showEmailError = attempted && !!emailError
  const showPasswordError = attempted && !!passwordError

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (emailError || passwordError || inviteError) {
      setAttempted(true)
      return
    }
    setBusy(true)
    setError('')
    try {
      if (isRegister) {
        const res = await apiFetch<{ token: string; email: string; role: string; apiKey?: string }>('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({ email: email.trim(), password, inviteCode: inviteCode.trim() }),
        })
        if (res.apiKey) {
          setRegistration({ token: res.token, apiKey: res.apiKey })
          return
        }
        setToken(res.token)
        toast.success('Account created! Welcome to FreeLLMAPI.')
        onAuthed()
        return
      }

      const payload: Record<string, string> = { email, password }
      // Only the setup flow carries a code, and only once the server has asked
      // for it. The server ignores it for local (loopback) setup.
      if (isSetup && setupCode) payload.setupCode = setupCode.trim()
      const res = await apiFetch<{ token: string }>(isSetup ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      setToken(res.token)
      onAuthed()
    } catch (err) {
      // The server gates remote first-run setup behind a one-time code; reveal
      // the field so the operator can paste the code from the server logs.
      if (isSetup && (err as ApiError).code === 'setup_code_required') {
        setCodeRequired(true)
      }
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (registration) {
    return <Centered><RegistrationKeyNotice apiKey={registration.apiKey} onContinue={() => {
      setToken(registration.token)
      setRegistration(null)
      onAuthed()
    }} /></Centered>
  }

  if (showForgot && !isSetup) {
    if (methods?.emailResetEnabled && !useLegacyForgot) {
      return (
        <Centered>
          <div className="mb-6 flex items-center gap-2">
            <span className="inline-block size-2 rounded-full bg-foreground" />
            <span className="font-semibold tracking-tight text-sm">FreeLLMAPI</span>
          </div>
          <EmailRecoveryForm
            onBack={() => { setShowForgot(false); setUseLegacyForgot(false); }}
            legacyResetAllowed={methods.legacyResetAllowed}
            onLegacyReset={() => setUseLegacyForgot(true)}
          />
        </Centered>
      )
    }
    return <ForgotPasswordForm onBack={() => { setShowForgot(false); setUseLegacyForgot(false); }} onAuthed={onAuthed} />
  }

  return (
    <Centered>
      <div className="mb-6 flex items-center gap-2">
        <span className="inline-block size-2 rounded-full bg-foreground" />
        <span className="font-semibold tracking-tight text-sm">FreeLLMAPI</span>
      </div>
      <div className="rounded-3xl border bg-card p-6">
        <h1 className="text-lg font-semibold tracking-tight">
          {isSetup
            ? t('auth.createYourAccount')
            : isRegister
              ? 'Register with invite code'
              : t('auth.signIn')}
        </h1>
        <p className="text-sm text-muted-foreground mt-1.5 mb-6">
          {isSetup
            ? t('auth.setupDescription')
            : isRegister
              ? 'Enter your invite code, email, and password to create an account.'
              : t('auth.loginDescription')}
        </p>
        {methods?.googleEnabled && !isSetup && (
          <div className="mb-4 space-y-4">
            <GoogleSignInButton inviteCode={isRegister ? inviteCode : undefined} />
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-card px-2 text-muted-foreground">Or</span>
              </div>
            </div>
          </div>
        )}
        <form onSubmit={submit} className="space-y-4" noValidate>
          {isRegister && (
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="auth-invite-code">Invite code</Label>
              <Input
                id="auth-invite-code"
                type="text"
                autoComplete="off"
                autoFocus
                value={inviteCode}
                onChange={e => setInviteCode(e.target.value)}
                placeholder="INV-XXXX-XXXX"
                aria-invalid={showInviteError}
                aria-describedby={showInviteError ? 'auth-invite-error' : undefined}
              />
              {attempted && <FieldError id="auth-invite-error" error={inviteError} />}
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="auth-email">{t('auth.email')}</Label>
            <Input
              id="auth-email"
              type="email"
              autoComplete="username"
              autoFocus={!isRegister}
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder={t('auth.emailPlaceholder')}
              aria-invalid={showEmailError}
              aria-describedby={showEmailError ? 'auth-email-error' : undefined}
            />
            {attempted && <FieldError id="auth-email-error" error={emailError} />}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="auth-password">{t('auth.password')}</Label>
            <PasswordInput
              id="auth-password"
              autoComplete={isSetup || isRegister ? 'new-password' : 'current-password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={isSetup || isRegister ? t('auth.passwordPlaceholderSetup') : t('auth.passwordPlaceholderLogin')}
              aria-invalid={showPasswordError}
              aria-describedby={showPasswordError ? 'auth-password-error' : undefined}
            />
            {attempted && <FieldError id="auth-password-error" error={passwordError} />}
          </div>
          {isSetup && codeRequired && (
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="auth-setup-code">{t('auth.setupCode')}</Label>
              <Input
                id="auth-setup-code"
                type="text"
                autoComplete="off"
                value={setupCode}
                onChange={e => setSetupCode(e.target.value)}
                placeholder={t('auth.setupCodePlaceholder')}
                aria-describedby="auth-setup-code-hint"
              />
              <p id="auth-setup-code-hint" className="text-xs text-muted-foreground">{t('auth.setupCodeHint')}</p>
            </div>
          )}
          {/* A server rejection is the one error nobody can predict; it gets the same
              announcement and the same visual weight as the inline field errors. */}
          {(error || externalError) && (
            <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error || externalError}
            </p>
          )}
          <Button type="submit" className="w-full h-10" disabled={busy}>
            {busy && <Loader2 className="animate-spin" aria-hidden />}
            {busy
              ? (isSetup ? t('auth.creating') : isRegister ? 'Creating account…' : t('auth.signingIn'))
              : isSetup ? t('auth.createAccount') : isRegister ? 'Register' : t('auth.signIn')}
          </Button>
        </form>
        {isLogin && (
          <div className="mt-3 space-y-3">
            <button
              type="button"
              onClick={() => setShowForgot(true)}
              className="w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {t('auth.forgotPassword')}
            </button>
            <div className="pt-3 border-t text-center">
              <button
                type="button"
                onClick={() => { setAuthView('register'); setError(''); setAttempted(false) }}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Have an invite code? <span className="font-medium text-foreground underline underline-offset-2">Register here</span>
              </button>
            </div>
          </div>
        )}
        {isRegister && (
          <div className="mt-4 pt-3 border-t text-center">
            <button
              type="button"
              onClick={() => { setAuthView('login'); setError(''); setAttempted(false) }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Already have an account? <span className="font-medium text-foreground underline underline-offset-2">Sign in</span>
            </button>
          </div>
        )}
      </div>
    </Centered>
  )
}

// Forgot / Reset password flow

type ForgotStep = 'request' | 'reset' | 'done'

function ForgotPasswordForm({ onBack, onAuthed }: { onBack: () => void; onAuthed: () => void }) {
  const { t } = useI18n()
  const [step, setStep] = useState<ForgotStep>('request')
  const [resetCode, setResetCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempted, setAttempted] = useState(false)

  const passwordError = !newPassword
    ? t('validation.required')
    : newPassword.length < PASSWORD_MIN
      ? t('validation.passwordMin', { min: PASSWORD_MIN })
      : null
  const codeError = !resetCode.trim() ? t('validation.required') : null

  async function requestCode() {
    setBusy(true)
    setError('')
    try {
      await apiFetch('/api/auth/forgot-password', { method: 'POST' })
      setStep('reset')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault()
    if (codeError || passwordError) {
      setAttempted(true)
      return
    }
    setBusy(true)
    setError('')
    try {
      const res = await apiFetch<{ token?: string }>('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ resetCode: resetCode.trim(), newPassword }),
      })
      // The server signs the operator in after a reset, so nobody has to
      // remember which email the account uses (#1477).
      if (res.token) {
        setToken(res.token)
        onAuthed()
        return
      }
      setStep('done')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Centered>
      <div className="mb-6 flex items-center gap-2">
        <span className="inline-block size-2 rounded-full bg-foreground" />
        <span className="font-semibold tracking-tight text-sm">FreeLLMAPI</span>
      </div>
      <div className="rounded-3xl border bg-card p-6">
        <h1 className="text-base font-medium">{t('auth.forgotPassword')}</h1>

        {step === 'request' && (
          <div className="mt-1 space-y-3">
            <p className="text-xs text-muted-foreground mb-4">{t('auth.forgotPasswordDescription')}</p>
            {error && <p className="text-destructive text-xs">{error}</p>}
            <Button className="w-full" disabled={busy} onClick={requestCode}>
              {busy ? t('auth.requestingResetCode') : t('auth.requestResetCode')}
            </Button>
          </div>
        )}

        {step === 'reset' && (
          <form onSubmit={submitReset} className="space-y-3 mt-4" noValidate>
            <p className="text-xs text-muted-foreground">{t('auth.resetCodeHint')}</p>
            <p className="text-xs text-muted-foreground">{t('auth.resetCodeDockerHint')}</p>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="reset-code">{t('auth.resetCode')}</Label>
              <Input
                id="reset-code"
                type="text"
                autoComplete="off"
                value={resetCode}
                onChange={e => setResetCode(e.target.value)}
                placeholder={t('auth.resetCodePlaceholder')}
                aria-invalid={attempted && !!codeError}
              />
              {attempted && <FieldError error={codeError} />}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="reset-new-password">{t('auth.newPassword')}</Label>
              <PasswordInput
                id="reset-new-password"
                autoComplete="new-password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder={t('auth.passwordPlaceholderSetup')}
                aria-invalid={attempted && !!passwordError}
              />
              {attempted && <FieldError error={passwordError} />}
            </div>
            {error && <p className="text-destructive text-xs">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? t('auth.resettingPassword') : t('auth.resetPassword')}
            </Button>
          </form>
        )}

        {step === 'done' && (
          <p className="text-xs text-muted-foreground mt-1 mb-4">{t('auth.passwordReset')}</p>
        )}

        <button
          type="button"
          onClick={onBack}
          className="mt-3 w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {t('auth.backToLogin')}
        </button>
      </div>
    </Centered>
  )
}

// Change-credentials modal (rendered inside the authenticated shell)

interface ChangeCredentialsModalProps {
  mode: 'password' | 'email'
  onClose: () => void
}

export function ChangeCredentialsModal({ mode, onClose }: ChangeCredentialsModalProps) {
  const { t } = useI18n()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newValue, setNewValue] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempted, setAttempted] = useState(false)

  const isPassword = mode === 'password'

  const newValueError = !newValue.trim()
    ? t('validation.required')
    : isPassword && newValue.length < PASSWORD_MIN
      ? t('validation.passwordMin', { min: PASSWORD_MIN })
      : !isPassword && !isEmail(newValue)
        ? t('validation.email')
        : null
  const currentPwError = !currentPassword ? t('validation.required') : null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (newValueError || currentPwError) {
      setAttempted(true)
      return
    }
    setBusy(true)
    setError('')
    try {
      if (isPassword) {
        await apiFetch('/api/auth/change-password', {
          method: 'POST',
          body: JSON.stringify({ currentPassword, newPassword: newValue }),
        })
        toast.success(t('auth.passwordChanged'))
      } else {
        await apiFetch('/api/auth/change-email', {
          method: 'POST',
          body: JSON.stringify({ currentPassword, newEmail: newValue }),
        })
        toast.success(t('auth.emailChanged'))
      }
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-sm rounded-3xl border bg-card p-6 shadow-xl">
        <h2 className="text-base font-medium mb-1">
          {isPassword ? t('auth.changePassword') : t('auth.changeEmail')}
        </h2>
        <form onSubmit={submit} className="space-y-3 mt-4" noValidate>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="cred-current-password">{t('auth.currentPassword')}</Label>
            <PasswordInput
              id="cred-current-password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              placeholder={t('auth.passwordPlaceholderLogin')}
              aria-invalid={attempted && !!currentPwError}
            />
            {attempted && <FieldError error={currentPwError} />}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="cred-new-value">
              {isPassword ? t('auth.newPassword') : t('auth.newEmail')}
            </Label>
            {isPassword ? <PasswordInput
              id="cred-new-value"
              autoComplete="new-password"
              value={newValue}
              onChange={e => setNewValue(e.target.value)}
              placeholder={t('auth.passwordPlaceholderSetup')}
              aria-invalid={attempted && !!newValueError}
            /> : <Input
              id="cred-new-value"
              type="email"
              autoComplete="email"
              value={newValue}
              onChange={e => setNewValue(e.target.value)}
              placeholder={t('auth.emailPlaceholder')}
              aria-invalid={attempted && !!newValueError}
            />}
            {attempted && <FieldError error={newValueError} />}
          </div>
          {error && <p className="text-destructive text-xs">{error}</p>}
          <div className="flex gap-2 pt-1">
            <Button type="button" variant="outline" className="flex-1" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" className="flex-1" disabled={busy}>
              {busy
                ? (isPassword ? t('auth.changingPassword') : t('auth.changingEmail'))
                : t('common.save')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const revision = useSessionBoundary()
  const [resetToken, setResetToken] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    if (window.location.hash.startsWith('#reset_token=')) {
      const token = window.location.hash.slice('#reset_token='.length)
      try {
        window.history.replaceState(null, '', window.location.pathname + window.location.search)
      } catch { /* ignore */ }
      return token
    }
    return null
  })
  const [googleHandoffResult, setGoogleHandoffResult] = useState<{ token: string; apiKey?: string } | null>(null)
  const [authError, setAuthError] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    const params = new URLSearchParams(window.location.search)
    if (params.get('auth_error') === 'google_failed') {
      try {
        params.delete('auth_error')
        const search = params.toString() ? `?${params.toString()}` : ''
        window.history.replaceState(null, '', window.location.pathname + search)
      } catch { /* ignore */ }
      return 'Google sign-in was cancelled or failed. If registering, an invite code is required.'
    }
    return null
  })
  const { data, isLoading, isError, refetch } = useQuery<AuthStatus>({
    queryKey: ['auth-status', revision],
    queryFn: () => apiFetch('/api/auth/status'),
    retry: false,
  })

  useEffect(() => {
    const handler = () => { refetch() }
    window.addEventListener(UNAUTHORIZED_EVENT, handler)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handler)
  }, [refetch])

  // Desktop self-repair: one attempt at a time, and none after the shell has
  // handed back a session the server still rejects — a broken install shows a
  // message instead of looping.
  const desktopSession = desktopSessionBridge() ?? (data?.desktop ? browserDesktopSession : null)
  const desktopNeedsSession = !!desktopSession && !!data && (data.needsSetup || !data.authenticated)
  const repairing = useRef(false)
  const [repairFailed, setRepairFailed] = useState(false)
  useEffect(() => {
    if (!desktopNeedsSession || !desktopSession || repairing.current || repairFailed) return
    repairing.current = true
    ;(async () => {
      try {
        const token = await desktopSession()
        if (!token) throw new Error('empty session token')
        setToken(token)
        queryClient.invalidateQueries()
        const next = await refetch()
        if (!next.data?.authenticated) setRepairFailed(true)
      } catch (err) {
        console.error('[auth-gate] desktop session repair failed', err)
        setRepairFailed(true)
      } finally {
        repairing.current = false
      }
    })()
  }, [desktopNeedsSession, desktopSession, repairFailed, queryClient, refetch])

  function onAuthed() {
    // New session: drop any cached (unauthenticated) data and re-check status.
    queryClient.invalidateQueries()
    refetch()
  }

  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('auth') === 'google') {
      try {
        params.delete('auth')
        const search = params.toString() ? `?${params.toString()}` : ''
        window.history.replaceState(null, '', window.location.pathname + search)
      } catch { /* ignore */ }

      apiFetch<{ token: string; email: string; role: 'admin' | 'member'; apiKey?: string }>('/api/auth/google/complete', {
        method: 'POST',
      })
        .then((res) => {
          if (res.apiKey) {
            setGoogleHandoffResult({ token: res.token, apiKey: res.apiKey })
          } else {
            setToken(res.token)
            onAuthed()
          }
        })
        .catch((err) => {
          setAuthError((err as Error).message || 'Google sign-in could not be completed.')
        })
    }
  }, [])

  if (isLoading) {
    return (
      <Centered>
        <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {t('auth.loading')}
        </p>
      </Centered>
    )
  }
  if (isError || !data) {
    return (
      <Centered>
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
          {t('auth.serverUnreachableBefore')}<code className="font-mono">npm run dev</code>{t('auth.serverUnreachableAfter')}
        </div>
      </Centered>
    )
  }

  if (desktopNeedsSession) {
    if (repairFailed) {
      return (
        <Centered>
          <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
            {t('auth.desktopSessionFailed')}
          </div>
        </Centered>
      )
    }
    return <Centered><p className="flex items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-3.5 animate-spin" aria-hidden />{t('auth.loading')}</p></Centered>
  }
  if (resetToken) {
    return (
      <Centered>
        <div className="mb-6 flex items-center gap-2">
          <span className="inline-block size-2 rounded-full bg-foreground" />
          <span className="font-semibold tracking-tight text-sm">FreeLLMAPI</span>
        </div>
        <ResetPasswordForm
          token={resetToken}
          onSuccess={() => setResetToken(null)}
          onCancel={() => setResetToken(null)}
        />
      </Centered>
    )
  }

  if (googleHandoffResult) {
    return (
      <Centered>
        <RegistrationKeyNotice
          apiKey={googleHandoffResult.apiKey!}
          onContinue={() => {
            setToken(googleHandoffResult.token)
            setGoogleHandoffResult(null)
            onAuthed()
          }}
        />
      </Centered>
    )
  }

  if (data.needsSetup) return <AuthForm mode="setup" onAuthed={onAuthed} />
  if (!data.authenticated) return <AuthForm mode="login" onAuthed={onAuthed} externalError={authError} />

  return <div key={revision} className="contents">{children}</div>
}


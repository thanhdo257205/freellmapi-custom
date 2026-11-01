import { useState, type ReactNode } from 'react'
import { apiFetch, clearToken, type ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'
import { Label } from '@/components/ui/label'
import { useExternalAuthMethods } from './use-external-auth'

function RecoveryContainer({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-dvh flex items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">{children}</div>
    </main>
  )
}

export function ExternalForgotPassword({
  onBack,
  legacy,
}: {
  onBack: () => void
  legacy: ReactNode
}) {
  const { data, isPending, isError, error, refetch } = useExternalAuthMethods()
  if (isPending)
    return (
      <RecoveryContainer>
        <p role="status">Loading recovery options…</p>
      </RecoveryContainer>
    )
  if (data?.emailResetEnabled)
    return (
      <RecoveryContainer>
        <EmailRecovery onBack={onBack} />
      </RecoveryContainer>
    )
  if (
    data?.legacyResetAllowed === true ||
    (isError && (error as ApiError).status === 404)
  )
    return <>{legacy}</>
  if (isError)
    return (
      <RecoveryContainer>
        <div className="rounded-3xl border bg-card p-6 space-y-4">
          <p role="alert">Unable to load recovery options. Please try again.</p>
          <Button onClick={() => refetch()}>Retry</Button>
          <Button variant="outline" onClick={onBack}>
            Back to sign in
          </Button>
        </div>
      </RecoveryContainer>
    )
  return (
    <RecoveryContainer>
      <div className="rounded-3xl border bg-card p-6 space-y-4">
        <h1 className="text-lg font-semibold">Password recovery</h1>
        <p className="text-sm text-muted-foreground">
          Email recovery is not configured yet. Contact your administrator, or
          use Google if your account is linked.
        </p>
        <Button variant="outline" onClick={onBack}>
          Back to sign in
        </Button>
      </div>
    </RecoveryContainer>
  )
}

export function EmailRecovery({
  resetToken,
  onBack,
}: {
  resetToken?: string
  onBack: () => void
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const resetting = resetToken !== undefined
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    if (
      resetting &&
      (password.length < 8 ||
        password.length > 128 ||
        password !== confirmation)
    ) {
      setError('Use 8–128 characters and make sure both passwords match.')
      return
    }
    setBusy(true)
    try {
      await apiFetch(
        resetting
          ? '/api/auth/email/reset-password'
          : '/api/auth/email/forgot-password',
        {
          method: 'POST',
          body: JSON.stringify(
            resetting
              ? { token: resetToken, newPassword: password }
              : { email: email.trim() },
          ),
        },
      )
      if (resetting) clearToken()
      setPassword('')
      setConfirmation('')
      setDone(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="rounded-3xl border bg-card p-6 space-y-4">
      <h1 className="text-lg font-semibold">
        {resetting ? 'Choose a new password' : 'Forgot your password?'}
      </h1>
      {done ? (
        <p role="status" className="text-sm text-muted-foreground">
          {resetting
            ? 'Your password has been changed. Sign in with your new password. Your previous sessions have been signed out.'
            : 'If an account exists, a reset link will be sent to that email. Check your inbox and spam folder. The link expires in 15 minutes.'}
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {resetting ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="email-reset-password">New password</Label>
                <PasswordInput
                  id="email-reset-password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={8}
                  maxLength={128}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email-reset-confirm">Confirm password</Label>
                <PasswordInput
                  id="email-reset-confirm"
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  minLength={8}
                  maxLength={128}
                  required
                />
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="recovery-email">Account email</Label>
              <Input
                id="recovery-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                maxLength={254}
                required
              />
              <p className="text-xs text-muted-foreground">
                Enter the email used for your FreeLLMAPI account.
              </p>
            </div>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy
              ? 'Please wait…'
              : resetting
                ? 'Save new password'
                : 'Send reset link'}
          </Button>
        </form>
      )}
      <Button type="button" variant="outline" onClick={onBack}>
        Back to sign in
      </Button>
    </div>
  )
}

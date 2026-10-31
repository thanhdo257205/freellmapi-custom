import { useState } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PasswordInput } from '@/components/ui/password-input'
import { Label } from '@/components/ui/label'
import { FieldError } from '@/components/ui/field-error'
import { apiFetch } from '@/lib/api'

interface ResetPasswordFormProps {
  token: string
  onSuccess: () => void
  onCancel: () => void
}

const PASSWORD_MIN = 8

export function ResetPasswordForm({ token, onSuccess, onCancel }: ResetPasswordFormProps) {
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [attempted, setAttempted] = useState(false)

  const passwordError = !newPassword
    ? 'Password is required'
    : newPassword.length < PASSWORD_MIN
      ? `Password must be at least ${PASSWORD_MIN} characters`
      : null

  const confirmError = !confirmPassword
    ? 'Please confirm your password'
    : confirmPassword !== newPassword
      ? 'Passwords do not match'
      : null

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (passwordError || confirmError) {
      setAttempted(true)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await apiFetch('/api/auth/email/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, newPassword }),
      })
      setSuccess(true)
    } catch (err) {
      setError((err as Error).message || 'Failed to reset password. The link may have expired.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-3xl border bg-card p-6">
      <h1 className="text-lg font-semibold tracking-tight">Reset your password</h1>
      {success ? (
        <div className="mt-4 space-y-4">
          <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4 text-xs">
            <CheckCircle2 className="size-5 shrink-0 text-primary mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium text-foreground">Password updated</p>
              <p className="text-muted-foreground leading-relaxed">
                Your password has been changed successfully. You can now sign in with your new password.
              </p>
            </div>
          </div>
          <Button type="button" className="w-full h-10" onClick={onSuccess}>
            Sign in
          </Button>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground mt-1.5 mb-6">
            Enter a new password for your account (minimum {PASSWORD_MIN} characters).
          </p>
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="reset-new-password">
                New password
              </Label>
              <PasswordInput
                id="reset-new-password"
                autoComplete="new-password"
                autoFocus
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter new password"
                aria-invalid={attempted && !!passwordError}
              />
              {attempted && <FieldError error={passwordError} />}
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="reset-confirm-password">
                Confirm new password
              </Label>
              <PasswordInput
                id="reset-confirm-password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm new password"
                aria-invalid={attempted && !!confirmError}
              />
              {attempted && <FieldError error={confirmError} />}
            </div>

            {error && (
              <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" className="w-full h-10" disabled={busy}>
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              {busy ? 'Updating password…' : 'Set new password'}
            </Button>
          </form>

          <div className="mt-4 pt-2 text-center">
            <button
              type="button"
              onClick={onCancel}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel and back to sign in
            </button>
          </div>
        </>
      )}
    </div>
  )
}

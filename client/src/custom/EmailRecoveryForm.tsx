import { useState } from 'react'
import { Loader2, MailCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FieldError } from '@/components/ui/field-error'
import { isEmail } from '@/lib/validate'
import { apiFetch } from '@/lib/api'

interface EmailRecoveryFormProps {
  onBack: () => void
  legacyResetAllowed?: boolean
  onLegacyReset?: () => void
}

export function EmailRecoveryForm({ onBack, legacyResetAllowed, onLegacyReset }: EmailRecoveryFormProps) {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [attempted, setAttempted] = useState(false)

  const emailError = !email.trim()
    ? 'Email is required'
    : !isEmail(email)
      ? 'Please enter a valid email address'
      : null

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (emailError) {
      setAttempted(true)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await apiFetch('/api/auth/email/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim() }),
      })
      setSubmitted(true)
    } catch (err) {
      setError((err as Error).message || 'Failed to request password reset')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-3xl border bg-card p-6">
      <h1 className="text-lg font-semibold tracking-tight">Forgot password?</h1>
      {submitted ? (
        <div className="mt-4 space-y-4">
          <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4 text-xs">
            <MailCheck className="size-5 shrink-0 text-primary mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium text-foreground">Check your email</p>
              <p className="text-muted-foreground leading-relaxed">
                If an account with that email exists, we have sent instructions to reset your password. The link expires in 15 minutes.
              </p>
            </div>
          </div>
          <Button type="button" className="w-full h-10" onClick={onBack}>
            Back to sign in
          </Button>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground mt-1.5 mb-6">
            Enter your account email to receive a password reset link.
          </p>
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="recovery-email">
                Email address
              </Label>
              <Input
                id="recovery-email"
                type="email"
                autoComplete="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                aria-invalid={attempted && !!emailError}
              />
              {attempted && <FieldError error={emailError} />}
            </div>

            {error && (
              <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" className="w-full h-10" disabled={busy}>
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              {busy ? 'Sending link…' : 'Send reset link'}
            </Button>
          </form>

          <div className="mt-4 space-y-3">
            {legacyResetAllowed && onLegacyReset && (
              <button
                type="button"
                onClick={onLegacyReset}
                className="w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Have a server log code? Use console reset
              </button>
            )}
            <div className="pt-2 text-center">
              <button
                type="button"
                onClick={onBack}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Back to sign in
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

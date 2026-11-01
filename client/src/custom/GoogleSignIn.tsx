import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { useExternalAuthMethods } from './use-external-auth'

export function GoogleSignIn({
  inviteCode,
  requiresInvite = false,
}: {
  inviteCode?: string
  requiresInvite?: boolean
}) {
  const { data } = useExternalAuthMethods()
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(() => {
    const raw = new URLSearchParams(window.location.search).get('auth_error')
    if (!raw) return ''
    if (raw === 'missing_attempt_cookie') return t('auth.googleCookieError')
    if (raw.includes('Google token exchange failed'))
      return t('auth.googleTokenError', { detail: raw })
    if (raw === 'A valid invitation is required')
      return t('auth.googleInviteRequiredError')
    if (raw === 'Existing account cannot be linked by this Google email')
      return t('auth.googleLinkConflictError')
    if (raw === 'google_failed') return t('auth.googleError')
    return t('auth.googleFailedDetail', { detail: raw })
  })
  useEffect(() => {
    const url = new URL(window.location.href)
    if (url.searchParams.has('auth_error')) {
      url.searchParams.delete('auth_error')
      window.history.replaceState(
        window.history.state,
        '',
        url.pathname + url.search + url.hash,
      )
    }
  }, [])
  async function start() {
    setBusy(true)
    setError('')
    try {
      const { url } = await apiFetch<{ url: string }>(
        '/api/auth/google/start',
        {
          method: 'POST',
          body: JSON.stringify({ inviteCode: inviteCode?.trim() || undefined }),
        },
      )
      const destination = new URL(url)
      if (destination.origin !== 'https://accounts.google.com')
        throw new Error('Invalid Google sign-in destination')
      window.location.assign(destination.href)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  return (
    <div className="mt-4 space-y-3">
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {data?.googleEnabled && (
        <>
          <Button
            type="button"
            variant="outline"
            className="w-full h-10"
            disabled={busy || (requiresInvite && !inviteCode?.trim())}
            onClick={start}
          >
            {busy ? t('auth.connectingGoogle') : t('auth.continueWithGoogle')}
          </Button>
          {requiresInvite && (
            <p className="text-xs text-muted-foreground">
              {t('auth.googleInviteRequired')}
            </p>
          )}
        </>
      )}
    </div>
  )
}

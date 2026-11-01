import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { useExternalAuthMethods } from './use-external-auth'

export function GoogleSignIn({
  inviteCode,
  requiresInvite = false,
}: {
  inviteCode?: string
  requiresInvite?: boolean
}) {
  const { data } = useExternalAuthMethods()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(() => {
    const raw = new URLSearchParams(window.location.search).get('auth_error')
    if (!raw) return ''
    if (raw === 'missing_attempt_cookie') {
      return 'Lỗi phiên đăng nhập: Trình duyệt không gửi được cookie xác thực. Vui lòng thử lại hoặc tắt chặn cookie bên thứ ba.'
    }
    if (raw.includes('Google token exchange failed')) {
      return `Lỗi kết nối Google (${raw}). Vui lòng kiểm tra lại cấu hình Google Client Secret trên Render.`
    }
    if (raw === 'A valid invitation is required') {
      return 'Tài khoản Google này chưa có trong danh sách người dùng và không có mã mời hợp lệ. Vui lòng đăng nhập bằng Mật khẩu hoặc gửi yêu cầu xét duyệt.'
    }
    if (raw === 'Existing account cannot be linked by this Google email') {
      return 'Tài khoản email này đã được liên kết với một tài khoản Google khác.'
    }
    if (raw === 'google_failed') {
      return 'Google sign-in failed or was cancelled. For a new account, open your invitation link and try again.'
    }
    return `Đăng nhập Google thất bại: ${raw}`
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
            {busy ? 'Connecting to Google…' : 'Continue with Google'}
          </Button>
          {requiresInvite && (
            <p className="text-xs text-muted-foreground">
              An invite code is required for a new Google account.
            </p>
          )}
        </>
      )}
    </div>
  )
}

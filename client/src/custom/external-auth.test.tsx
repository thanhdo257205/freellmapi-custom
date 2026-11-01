// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthGate } from '@/components/auth-gate'
import { I18nProvider } from '@/i18n'
import { getToken, setToken } from '@/lib/api'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let client: QueryClient
let calls: { path: string; body: Record<string, string> }[]
let methodsFailureStatus = 0
let callbackResult: Record<string, string>
let loginFailure: { status: number; type: string; message: string } | null = null
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
    status,
  })
async function flush() {
  for (let i = 0; i < 8; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
}
function type(id: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(id)!
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function click(text: string) {
  act(() =>
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === text)!
      .click(),
  )
  await flush()
}
async function submit() {
  act(() =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  await flush()
}
async function mount(url = '/', locale: 'en' | 'vi' = 'en') {
  window.history.replaceState({}, '', url)
  act(() =>
    root.render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <I18nProvider initialLocale={locale}>
            <AuthGate>
              <div>signed-in dashboard</div>
            </AuthGate>
          </I18nProvider>
        </QueryClientProvider>
      </StrictMode>,
    ),
  )
  await flush()
}
beforeAll(() => {
  ;(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  calls = []
  methodsFailureStatus = 0
  loginFailure = null
  callbackResult = {
    token: 'google-session',
    role: 'member',
    email: 'member@gmail.com',
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const path = String(input)
      if (init?.method === 'POST')
        calls.push({ path, body: JSON.parse(String(init.body || '{}')) })
      if (path.endsWith('/api/auth/status'))
        return json({
          needsSetup: false,
          authenticated: !!getToken(),
          email: null,
        })
      if (path.endsWith('/api/auth/methods') && methodsFailureStatus)
        return json({ error: { message: 'Unavailable' } }, methodsFailureStatus)
      if (path.endsWith('/api/auth/methods'))
        return json({
          googleEnabled: true,
          emailResetEnabled: true,
          legacyResetAllowed: false,
        })
      if (path.endsWith('/api/auth/google/complete'))
        return json(callbackResult)
      if (
        loginFailure &&
        (path.endsWith('/api/auth/login') ||
          path.endsWith('/api/auth/request-access'))
      )
        return json({ error: loginFailure }, loginFailure.status)
      return json({ success: true })
    }),
  )
})
afterEach(() => {
  act(() => root.unmount())
  client.clear()
  container.remove()
  localStorage.clear()
  window.history.replaceState({}, '', '/')
  vi.unstubAllGlobals()
})

it('offers Google login and uses email recovery instead of console reset', async () => {
  await mount()
  expect(container.textContent).toContain('Continue with Google')
  await click('Forgot password?')
  expect(container.textContent).toContain('Account email')
  type('#recovery-email', 'member@gmail.com')
  await submit()
  expect(calls).toContainEqual({
    path: '/api/auth/email/forgot-password',
    body: { email: 'member@gmail.com' },
  })
  expect(container.textContent).toContain('If an account exists')
  expect(calls.some((call) => call.path === '/api/auth/forgot-password')).toBe(
    false,
  )
})

it('captures and erases the recovery fragment, confirms the password, and does not automatically log in', async () => {
  await mount('/#reset_token=one-time-test-token')
  expect(window.location.hash).toBe('')
  expect(container.textContent).not.toContain('one-time-test-token')
  type('#email-reset-password', 'ReplacementPassword!')
  type('#email-reset-confirm', 'DifferentPassword!')
  await submit()
  expect(calls).toHaveLength(0)
  type('#email-reset-confirm', 'ReplacementPassword!')
  await submit()
  expect(calls[0]).toEqual({
    path: '/api/auth/email/reset-password',
    body: { token: 'one-time-test-token', newPassword: 'ReplacementPassword!' },
  })
  expect(container.textContent).toContain('Your password has been changed')
  expect(getToken()).toBeNull()
  await click('Back to sign in')
  expect(container.textContent).toContain('Continue with Google')
})

it('redeems the Google result only once under StrictMode and removes the callback query', async () => {
  await mount('/?auth=google')
  expect(
    calls.filter((call) => call.path.endsWith('/google/complete')),
  ).toHaveLength(1)
  expect(window.location.search).toBe('')
  expect(getToken()).toBe('google-session')
  expect(container.textContent).toContain('signed-in dashboard')
})

it('shows the new member personal key once before storing the Google session', async () => {
  callbackResult.apiKey = 'sk-flm-google-initial-secret'
  await mount('/?auth=google')
  expect(container.textContent).toContain('sk-flm-google-initial-secret')
  expect(getToken()).toBeNull()
  await click('Continue to dashboard')
  expect(getToken()).toBe('google-session')
  expect(container.textContent).not.toContain('sk-flm-google-initial-secret')
  expect(JSON.stringify(localStorage)).not.toContain(
    'sk-flm-google-initial-secret',
  )
})

it('drops a pending Google key notice when another identity signs in', async () => {
  callbackResult.apiKey = 'sk-flm-old-user-secret'
  await mount('/?auth=google')
  expect(container.textContent).toContain('sk-flm-old-user-secret')
  act(() => setToken('another-user-session'))
  await flush()
  expect(container.textContent).not.toContain('sk-flm-old-user-secret')
  expect(getToken()).toBe('another-user-session')
  expect(container.textContent).toContain('signed-in dashboard')
})

it('shows recovery retry instead of console instructions when method discovery fails', async () => {
  methodsFailureStatus = 500
  await mount()
  await click('Forgot password?')
  expect(container.textContent).toContain('Unable to load recovery options')
  expect(container.textContent).not.toContain('Send reset code')
  expect(calls.some((call) => call.path === '/api/auth/forgot-password')).toBe(
    false,
  )
})

it('opens a recovery link when the browser navigates only to a new fragment', async () => {
  await mount()
  act(() => {
    window.location.hash = 'reset_token=arrived-later'
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  })
  await flush()
  expect(container.textContent).toContain('Choose a new password')
  expect(window.location.hash).toBe('')
})

// The register view shipped with English headings and buttons next to
// Vietnamese tabs, so every string on the card has to follow one locale.
it('renders the whole register view in the selected locale', async () => {
  await mount('/?mode=register', 'vi')
  const text = container.textContent!
  expect(text).toContain('Đăng ký bằng mã mời')
  expect(text).toContain('Nhập mã mời, email và mật khẩu để tạo tài khoản.')
  expect(text).toContain('Mã mời')
  expect(text).toContain('Tiếp tục với Google')
  expect(text).toContain('Đã có tài khoản?')
  expect(text).not.toContain('Invite code')
  expect(text).not.toContain('Register with invite code')
  expect(text).not.toContain('Continue with Google')
  expect(text).not.toContain('Already have an account')

  await click('Yêu cầu xét duyệt')
  const requestText = container.textContent!
  expect(requestText).toContain('Xin cấp quyền truy cập')
  expect(requestText).toContain('Ghi chú cho Quản trị viên (tùy chọn)')
  expect(requestText).toContain('Gửi yêu cầu xét duyệt')
  expect(
    container.querySelector<HTMLInputElement>('#auth-request-note')!.placeholder,
  ).toBe('Ví dụ: Sinh viên, lập trình viên, nghiên cứu AI…')
  expect(requestText).not.toContain('Note for the admin')
  expect(requestText).not.toContain('Request account access')
})

// The approval notices come from the server in Vietnamese; the card must show
// them in the reader's language and keep the "waiting" styling.
it('shows a pending account in the reader language instead of the server language', async () => {
  loginFailure = {
    status: 403,
    type: 'registration_pending',
    message: 'Tài khoản của bạn đang chờ Admin phê duyệt. Vui lòng quay lại sau!',
  }
  await mount()
  type('#auth-email', 'member@gmail.com')
  type('#auth-password', 'Password123')
  await submit()
  const alert = container.querySelector('[role=alert]')!
  expect(alert.textContent).toBe(
    'Your account is waiting for admin approval. Please check back later.',
  )
  expect(alert.className).toContain('amber')
})

it('localizes a duplicate access request and keeps it non-destructive', async () => {
  loginFailure = {
    status: 409,
    type: 'request_already_pending',
    message: 'Yêu cầu đăng ký cho email này đang chờ Admin phê duyệt.',
  }
  await mount()
  await click("Don't have an account? Sign up / Request access")
  await click('Request review')
  type('#auth-email', 'member@gmail.com')
  type('#auth-password', 'Password123')
  await submit()
  expect(calls.some((call) => call.path === '/api/auth/request-access')).toBe(
    true,
  )
  const alert = container.querySelector('[role=alert]')!
  expect(alert.textContent).toBe(
    'A registration request for this email is already waiting for approval.',
  )
  expect(alert.className).toContain('amber')
})

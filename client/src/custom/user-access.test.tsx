// @vitest-environment jsdom
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { InvitesPage } from '@/custom/InvitesPage'
import { UsersPage } from '@/custom/UsersPage'
import { MemberKeysView } from '@/custom/MemberKeysView'
import { useSessionBoundary, getSessionRevision } from '@/custom/session-state'
import { apiFetch, getToken, logout, setToken } from '@/lib/api'
import { MemoryRouter } from 'react-router-dom'
import KeysPage from '@/pages/KeysPage'
import { AuthGate } from '@/components/auth-gate'
import { useUserSession } from '@/custom/use-session'

vi.mock('@/components/keys/provider-list', () => ({ ProviderList: () => null }))
vi.mock('@/components/keys/provider-checklist-section', () => ({
  ProviderChecklistSection: () => null,
}))
vi.mock('@/components/keys/add-key-dialog', () => ({
  AddKeyDialog: () => null,
}))

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let client: QueryClient
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
async function flush() {
  for (let i = 0; i < 8; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
}
function Boundary({ children }: { children: React.ReactNode }) {
  useSessionBoundary()
  return <>{children}</>
}
function mount(component: React.ReactNode) {
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <Boundary>{component}</Boundary>
        </I18nProvider>
      </QueryClientProvider>,
    ),
  )
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
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
})
afterEach(() => {
  act(() => root.unmount())
  client.clear()
  container.remove()
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('multi-user dashboard regressions', () => {
  it.each([200, 401])(
    'rejects a stale %s response without changing the current token',
    async (status) => {
      setToken('old')
      let release!: (r: Response) => void
      vi.stubGlobal(
        'fetch',
        vi.fn(
          () =>
            new Promise<Response>((r) => {
              release = r
            }),
        ),
      )
      const request = apiFetch('/api/keys')
      const assertion = expect(request).rejects.toMatchObject({
        name: 'AbortError',
      })
      setToken('new')
      release(
        json(
          status === 200
            ? { apiKey: 'old-secret' }
            : { error: { type: 'authentication_error' } },
          status,
        ),
      )
      await assertion
      expect(getToken()).toBe('new')
    },
  )
  it('rejects a response whose body finishes after an identity switch', async () => {
    setToken('old')
    let release!: (body: string) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: () =>
          new Promise<string>((r) => {
            release = r
          }),
      })),
    )
    const request = apiFetch('/api/keys')
    const assertion = expect(request).rejects.toMatchObject({
      name: 'AbortError',
    })
    await Promise.resolve()
    setToken('new')
    release(JSON.stringify({ apiKey: 'old-secret' }))
    await assertion
  })
  it('clears cached secrets on a cross-tab token change', async () => {
    setToken('admin-session')
    mount(<div />)
    await flush()
    client.setQueryData(['unified-key'], { apiKey: 'old-secret' })
    act(() => {
      localStorage.setItem('freellmapi_dashboard_token', 'member-session')
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'freellmapi_dashboard_token',
          oldValue: 'admin-session',
          newValue: 'member-session',
        }),
      )
    })
    expect(client.getQueryData(['unified-key'])).toBeUndefined()
  })
  it('renders authoritative revoked status and expiry from the backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          invites: [
            {
              id: 1,
              code: 'REVOKED',
              maxUses: 2,
              usedCount: 0,
              expiresAtMs: 1,
              revoked: true,
              status: 'revoked',
              note: null,
              createdBy: 1,
              createdAt: '2026-01-01',
            },
          ],
        }),
      ),
    )
    mount(<InvitesPage />)
    await flush()
    expect(container.textContent).not.toContain('Expires: Never')
    expect(container.textContent).toContain('Revoked')
    expect(container.textContent).not.toContain('Expired')
  })
  it('closes the mint modal and reveals the one-time key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) =>
        init?.method === 'POST'
          ? json({
              key: { id: 1, key: 'sk-flm-new-secret', name: 'Default Key' },
            })
          : json({ keys: [] }),
      ),
    )
    mount(<MemberKeysView />)
    await flush()
    const button = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Generate New Key'),
    )!
    act(() => button.click())
    await flush()
    act(() =>
      container
        .querySelector('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        ),
    )
    await flush()
    expect(container.textContent).toContain('sk-flm-new-secret')
    expect(container.querySelector('.fixed.inset-0.z-50')).toBeNull()
  })
  it('closes the invite modal and reveals the new registration link', async () => {
    const invite = {
      id: 2,
      code: 'NEW-INVITE',
      status: 'active',
      revoked: false,
      expiresAtMs: null,
      maxUses: 1,
      usedCount: 0,
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) =>
        init?.method === 'POST' ? json({ invite }) : json({ invites: [] }),
      ),
    )
    mount(<InvitesPage />)
    await flush()
    act(() =>
      Array.from(container.querySelectorAll('button'))
        .find((b) => b.textContent?.includes('Create Invite Code'))!
        .click(),
    )
    await flush()
    act(() =>
      container
        .querySelector('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        ),
    )
    await flush()
    expect(container.querySelector('.fixed.inset-0.z-50')).toBeNull()
    expect(container.textContent).toContain('/?invite=NEW-INVITE')
  })
  it('excludes revoked keys from the active count and disables revocation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          keys: [
            {
              id: 1,
              name: 'Revoked token',
              keyPrefix: 'sk-flm-xxx',
              rpmLimit: 60,
              revoked: true,
              createdAt: '2026-01-01',
              lastUsedAt: null,
            },
          ],
        }),
      ),
    )
    mount(<MemberKeysView />)
    await flush()
    expect(container.textContent).toContain('Active Keys (0)')
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (b) => b.textContent?.trim() === 'Revoke',
      ),
    ).toBe(false)
  })
  it('erases the previous identity cache and mutation results on logout', async () => {
    setToken('admin-session')
    mount(<div />)
    await flush()
    client.setQueryData(['unified-key'], { apiKey: 'admin-unified-secret' })
    await act(async () => {
      await client
        .getMutationCache()
        .build(client, { mutationFn: async () => 'old-secret' })
        .execute(undefined)
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ ok: true })),
    )
    await act(async () => {
      await logout()
      setToken('member-session')
    })
    await flush()
    expect(client.getQueryData(['unified-key'])).toBeUndefined()
    expect(client.getMutationCache().getAll()).toHaveLength(0)
  })
  it('waits for the member role before mounting any admin queries', async () => {
    let release!: (r: Response) => void
    const pending = new Promise<Response>((r) => {
      release = r
    })
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        const u = String(url)
        calls.push(u)
        if (u.endsWith('/api/user/session')) return pending
        if (u.endsWith('/api/keys')) return json([], 403)
        if (u.endsWith('/api/user/keys')) return json({ keys: [] })
        return json({})
      }),
    )
    mount(
      <MemoryRouter initialEntries={['/keys']}>
        <KeysPage />
      </MemoryRouter>,
    )
    await flush()
    expect(calls.some((u) => u.endsWith('/api/keys'))).toBe(false)
    await act(async () =>
      release(json({ userId: 2, email: 'member@example.com', role: 'member' })),
    )
    await flush()
    expect(container.textContent).toContain('Personal API Keys')
  })
  it('never renders the old identity while a new session is loading', async () => {
    setToken('admin-session')
    mount(<div />)
    await flush()
    client.setQueryData(['user-session', getSessionRevision()], {
      userId: 1,
      email: 'admin@example.com',
      role: 'admin',
    })
    let release!: (r: Response) => void
    const pending = new Promise<Response>((r) => {
      release = r
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) =>
        String(url).endsWith('/api/auth/logout') ? json({ ok: true }) : pending,
      ),
    )
    await act(async () => {
      await logout()
      setToken('member-session')
    })
    function SessionView() {
      const { session } = useUserSession()
      return (
        <div>
          {session?.role}:{session?.email}
        </div>
      )
    }
    mount(<SessionView />)
    await flush()
    expect(container.textContent).not.toContain('admin@example.com')
    await act(async () =>
      release(json({ userId: 2, email: 'member@example.com', role: 'member' })),
    )
    await flush()
    expect(container.textContent).toBe('member:member@example.com')
  })
  it('shows the registration secret once before continuing to the dashboard', async () => {
    let authenticated = false
    window.history.replaceState({}, '', '/?invite=REVIEW')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        if (String(url).endsWith('/api/auth/status'))
          return json({
            needsSetup: false,
            authenticated,
            email: authenticated ? 'member@example.com' : null,
          })
        if (String(url).endsWith('/api/auth/register')) {
          authenticated = true
          return json(
            {
              token: 'new-session',
              email: 'member@example.com',
              role: 'member',
              apiKey: 'sk-flm-default-one-time-secret',
            },
            201,
          )
        }
        return json({})
      }),
    )
    mount(
      <AuthGate>
        <div>signed-in dashboard</div>
      </AuthGate>,
    )
    await flush()
    function type(selector: string, value: string) {
      const input = container.querySelector(selector)!
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!
      act(() => {
        setter.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    type('#auth-email', 'member@example.com')
    type('#auth-password', 'Password123!')
    act(() =>
      container
        .querySelector('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        ),
    )
    await flush()
    expect(container.textContent).not.toContain('signed-in dashboard')
    expect(container.textContent).toContain('sk-flm-default-one-time-secret')
    expect(getToken()).toBeNull()
    act(() =>
      Array.from(container.querySelectorAll('button'))
        .find((b) => b.textContent === 'Continue to dashboard')!
        .click(),
    )
    await flush()
    expect(container.textContent).toContain('signed-in dashboard')
    expect(container.textContent).not.toContain(
      'sk-flm-default-one-time-secret',
    )
    expect(localStorage.getItem('freellmapi_dashboard_token')).toBe(
      'new-session',
    )
    expect(JSON.stringify(localStorage)).not.toContain(
      'sk-flm-default-one-time-secret',
    )
    window.history.replaceState({}, '', '/')
  })
})

const ADMIN_ROW = {
  id: 1,
  email: 'owner@example.com',
  role: 'admin',
  createdAt: '2026-01-01',
  activeKeys: 0,
  sessions: 1,
  isSelf: true,
}
const MEMBER_ROW = {
  id: 2,
  email: 'guest@example.com',
  role: 'member',
  createdAt: '2026-02-01',
  activeKeys: 2,
  sessions: 3,
  isSelf: false,
}

describe('admin users page', () => {
  function stubUsers(rows: unknown[]) {
    const calls: Array<{ url: string; method?: string; body?: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        calls.push({
          url: String(url),
          method: init?.method,
          body: init?.body ? String(init.body) : undefined,
        })
        return json({ users: rows })
      }),
    )
    return calls
  }

  it('labels the caller row and refuses to offer a self-demote', async () => {
    stubUsers([ADMIN_ROW, MEMBER_ROW])
    mount(<UsersPage />)
    await flush()

    expect(container.textContent).toContain('owner@example.com')
    expect(container.textContent).toContain('You')
    expect(container.textContent).toContain('Accounts (2)')
    expect(container.textContent).toContain('Sessions: 3')

    const selfAction = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Demote to member',
    )!
    expect(selfAction.disabled).toBe(true)
  })

  it('fires the role change only on the second click of the armed button', async () => {
    const calls = stubUsers([ADMIN_ROW, MEMBER_ROW])
    mount(<UsersPage />)
    await flush()

    const promote = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Promote to admin',
    )!
    act(() => promote.click())
    await flush()
    // Armed, not yet sent: the label swapped to the confirmation copy.
    expect(
      container.textContent?.includes('Confirm promote'),
    ).toBe(true)
    expect(
      calls.some((c) => c.method === 'PATCH'),
    ).toBe(false)

    const armed = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Confirm promote',
    )!
    act(() => armed.click())
    await flush()
    const patch = calls.find((c) => c.method === 'PATCH')
    expect(patch?.url).toContain('/api/admin/users/2/role')
    expect(JSON.parse(patch!.body!)).toEqual({ role: 'admin' })
  })

  it('filters rows without asking the server again', async () => {
    const calls = stubUsers([ADMIN_ROW, MEMBER_ROW])
    mount(<UsersPage />)
    await flush()
    const readsBefore = calls.filter((c) => !c.method).length

    const input = container.querySelector('input')!
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!
    act(() => {
      setter.call(input, 'guest')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()

    expect(container.textContent).toContain('guest@example.com')
    expect(container.textContent).not.toContain('owner@example.com')
    expect(calls.filter((c) => !c.method)).toHaveLength(readsBefore)
  })

  it('shows an alert with a retry instead of an empty list when the read fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ error: { message: 'Forbidden', type: 'forbidden' } }, 403)),
    )
    mount(<UsersPage />)
    await flush()

    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(container.textContent).toContain('Forbidden')
    expect(container.textContent).not.toContain('No accounts yet')
  })
})

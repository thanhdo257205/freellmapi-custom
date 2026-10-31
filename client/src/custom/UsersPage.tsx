import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Users, LogOut, KeyRound } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/page-header'
import { ConfirmButton } from '@/components/confirm-button'
import { toast } from '@/lib/toast'

import type { AdminUser } from '../../../shared/user-access'
export type { AdminUser } from '../../../shared/user-access'

export function UsersPage() {
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState('')

  const {
    data, isLoading, isError, error, refetch,
  } = useQuery<{ users: AdminUser[] }>({
    queryKey: ['users'],
    queryFn: () => apiFetch<{ users: AdminUser[] }>('/api/admin/users'),
  })

  const users = data?.users ?? []
  const shown = filter.trim()
    ? users.filter(u => u.email.toLowerCase().includes(filter.trim().toLowerCase()))
    : users

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['users'] })

  const roleMutation = useMutation({
    mutationFn: ({ id, role }: { id: number; role: 'admin' | 'member' }) =>
      apiFetch<{ success: boolean }>(`/api/admin/users/${id}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      }),
    onSuccess: (_res, vars) => {
      refresh()
      toast.success(vars.role === 'admin' ? 'Account promoted to admin' : 'Account demoted to member')
    },
    onError: (err: any) => {
      toast.error(err.message || 'Failed to change role')
    },
  })

  const sessionsMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ revoked: number }>(`/api/admin/users/${id}/revoke-sessions`, { method: 'POST' }),
    onSuccess: (res) => {
      refresh()
      toast.success(res.revoked === 1 ? 'Session signed out' : `Signed out ${res.revoked} sessions`)
    },
    onError: (err: any) => {
      toast.error(err.message || 'Failed to sign out sessions')
    },
  })

  const keysMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ revoked: number }>(`/api/admin/users/${id}/revoke-keys`, { method: 'POST' }),
    onSuccess: (res) => {
      refresh()
      toast.success(res.revoked === 1 ? 'API key revoked' : `Revoked ${res.revoked} API keys`)
    },
    onError: (err: any) => {
      toast.error(err.message || 'Failed to revoke API keys')
    },
  })

  const busy = roleMutation.isPending || sessionsMutation.isPending || keysMutation.isPending

  return (
    <div className="space-y-8">
      <PageHeader
        title="Users"
        description="Every account on this instance. Roles decide which dashboard surfaces an account can reach; revoking ends access without deleting history."
      />

      <div className="rounded-2xl border bg-card overflow-hidden">
        <div className="border-b px-5 py-3.5 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Accounts ({users.length})</h2>
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by email…"
            className="h-8 w-full max-w-xs text-xs"
            aria-label="Filter accounts by email"
          />
        </div>

        {isLoading ? (
          <p className="p-8 text-center text-sm text-muted-foreground" role="status">Loading accounts…</p>
        ) : isError ? (
          <div className="p-8 text-center space-y-3" role="alert">
            <p className="text-sm font-medium text-destructive">
              {error?.message || 'Could not load accounts.'}
            </p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
          </div>
        ) : shown.length === 0 ? (
          <div className="p-8 text-center space-y-2">
            <Users className="size-8 mx-auto text-muted-foreground opacity-50" />
            <p className="text-sm font-medium">
              {users.length === 0 ? 'No accounts yet' : 'No account matches that filter'}
            </p>
            <p className="text-xs text-muted-foreground">
              Invite codes are how new members get created.
            </p>
          </div>
        ) : (
          <div className="divide-y">
            {shown.map((u) => (
              <div
                key={u.id}
                className="p-4 flex flex-wrap sm:flex-nowrap items-center justify-between gap-4 hover:bg-muted/30 transition-colors"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground truncate">{u.email}</span>
                    <span
                      className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${
                        u.role === 'admin'
                          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
                          : 'bg-muted text-muted-foreground border-transparent'
                      }`}
                    >
                      {u.role === 'admin' ? 'Admin' : 'Member'}
                    </span>
                    {u.isSelf && (
                      <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                        You
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                    <span>Joined: {new Date(u.createdAt).toLocaleDateString()}</span>
                    <span>Active keys: <strong>{u.activeKeys}</strong></span>
                    <span>Sessions: <strong>{u.sessions}</strong></span>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {u.isSelf ? (
                    <Button variant="ghost" size="sm" disabled className="text-xs h-8">
                      {u.role === 'admin' ? 'Demote to member' : 'Promote to admin'}
                    </Button>
                  ) : (
                    <ConfirmButton
                      onConfirm={() => roleMutation.mutate({
                        id: u.id,
                        role: u.role === 'admin' ? 'member' : 'admin',
                      })}
                      disabled={busy}
                      variant="ghost"
                      size="sm"
                      armedSize="sm"
                      confirmLabel={u.role === 'admin' ? 'Confirm demote' : 'Confirm promote'}
                      className={`text-xs h-8 ${u.role === 'admin' ? 'text-destructive hover:bg-destructive/10 hover:text-destructive' : ''}`}
                      title={u.role === 'admin'
                        ? 'Downgrade to member: their dashboard loses the admin surfaces on the next request.'
                        : 'Grant admin: full access to keys, settings, logs, backups and this page.'}
                    >
                      {u.role === 'admin' ? 'Demote to member' : 'Promote to admin'}
                    </ConfirmButton>
                  )}

                  <ConfirmButton
                    onConfirm={() => sessionsMutation.mutate(u.id)}
                    disabled={busy || u.sessions === 0}
                    variant="ghost"
                    size="icon"
                    armedSize="xs"
                    aria-label={`Sign out ${u.email}`}
                    title={u.isSelf
                      ? 'Signs every device out — including this tab.'
                      : 'Ends this account’s dashboard sessions. They can sign in again.'}
                    className="text-muted-foreground"
                  >
                    <LogOut className="size-3.5" />
                  </ConfirmButton>

                  <ConfirmButton
                    onConfirm={() => keysMutation.mutate(u.id)}
                    disabled={busy || u.activeKeys === 0}
                    variant="ghost"
                    size="icon"
                    armedSize="xs"
                    aria-label={`Revoke API keys of ${u.email}`}
                    title="Revokes every personal gateway key. Clients using them start failing immediately; the keys cannot be restored."
                    className="text-destructive hover:bg-destructive/10"
                  >
                    <KeyRound className="size-3.5" />
                  </ConfirmButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Creating and deleting accounts is not part of this page: accounts are born from
        invite codes, and this instance has no delete-account path.
      </p>
    </div>
  )
}

export default UsersPage

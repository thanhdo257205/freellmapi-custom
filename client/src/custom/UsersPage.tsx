import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Users, LogOut, KeyRound, Check, X, Clock, FileText } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/page-header'
import { ConfirmButton } from '@/components/confirm-button'
import { toast } from '@/lib/toast'

import type { AdminUser, RegistrationRequest } from '../../../shared/user-access'
export type { AdminUser, RegistrationRequest } from '../../../shared/user-access'

export function UsersPage() {
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState('')
  const [activeTab, setActiveTab] = useState<'accounts' | 'requests'>('accounts')

  const {
    data, isLoading, isError, error, refetch,
  } = useQuery<{ users: AdminUser[] }>({
    queryKey: ['users'],
    queryFn: () => apiFetch<{ users: AdminUser[] }>('/api/admin/users'),
  })

  const {
    data: requestsData,
    isLoading: requestsLoading,
    isError: requestsError,
    error: reqError,
    refetch: refetchRequests,
  } = useQuery<{ requests: RegistrationRequest[] }>({
    queryKey: ['registration-requests'],
    queryFn: () => apiFetch<{ requests: RegistrationRequest[] }>('/api/admin/registration-requests'),
  })

  const users = data?.users ?? []
  const requests = requestsData?.requests ?? []

  const shownUsers = filter.trim()
    ? users.filter(u => u.email.toLowerCase().includes(filter.trim().toLowerCase()))
    : users

  const shownRequests = filter.trim()
    ? requests.filter(r => r.email.toLowerCase().includes(filter.trim().toLowerCase()))
    : requests

  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: ['users'] })
    queryClient.invalidateQueries({ queryKey: ['registration-requests'] })
    queryClient.invalidateQueries({ queryKey: ['admin-users-usage'] })
  }

  const { data: usageData } = useQuery<{
    usage: Array<{ userId: number; email: string; requests: number; tokens: number; rpmLimit: number }>
  }>({
    queryKey: ['admin-users-usage'],
    queryFn: () =>
      apiFetch<{
        usage: Array<{ userId: number; email: string; requests: number; tokens: number; rpmLimit: number }>
      }>('/api/admin/users/usage'),
  })

  const usageMap = new Map((usageData?.usage ?? []).map(u => [u.userId, u]))

  const quotaMutation = useMutation({
    mutationFn: ({ id, rpmLimit }: { id: number; rpmLimit: number }) =>
      apiFetch<{ success: boolean; rpmLimit: number }>(`/api/admin/users/${id}/quota`, {
        method: 'PUT',
        body: JSON.stringify({ rpmLimit }),
      }),
    onSuccess: () => {
      refreshAll()
      toast.success('RPM quota limit updated')
    },
    onError: (err: any) => {
      toast.error(err.message || 'Failed to update RPM limit')
    },
  })

  const roleMutation = useMutation({
    mutationFn: ({ id, role }: { id: number; role: 'admin' | 'member' }) =>
      apiFetch<{ success: boolean }>(`/api/admin/users/${id}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      }),
    onSuccess: (_res, vars) => {
      refreshAll()
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
      refreshAll()
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
      refreshAll()
      toast.success(res.revoked === 1 ? 'API key revoked' : `Revoked ${res.revoked} API keys`)
    },
    onError: (err: any) => {
      toast.error(err.message || 'Failed to revoke API keys')
    },
  })

  const approveRequestMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ success: boolean; user: { id: number; email: string; role: string } }>(
        `/api/admin/registration-requests/${id}/approve`,
        { method: 'POST' },
      ),
    onSuccess: (res) => {
      refreshAll()
      toast.success(`Account approved for ${res.user.email}!`)
    },
    onError: (err: any) => {
      toast.error(err.message || 'Failed to approve registration request')
    },
  })

  const rejectRequestMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ success: boolean }>(`/api/admin/registration-requests/${id}/reject`, { method: 'POST' }),
    onSuccess: () => {
      refreshAll()
      toast.success('Registration request rejected')
    },
    onError: (err: any) => {
      toast.error(err.message || 'Failed to reject registration request')
    },
  })

  const busy =
    roleMutation.isPending ||
    sessionsMutation.isPending ||
    keysMutation.isPending ||
    approveRequestMutation.isPending ||
    rejectRequestMutation.isPending

  return (
    <div className="space-y-8">
      <PageHeader
        title="Users"
        description="Every account on this instance. Roles decide which dashboard surfaces an account can reach; approve pending access requests or manage active members."
      />

      <div className="flex items-center gap-2 border-b pb-4">
        <button
          type="button"
          onClick={() => setActiveTab('accounts')}
          className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-xl transition-colors ${
            activeTab === 'accounts'
              ? 'bg-primary text-primary-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'
          }`}
        >
          <Users className="size-3.5" />
          <span>Active Accounts ({users.length})</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('requests')}
          className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-xl transition-colors ${
            activeTab === 'requests'
              ? 'bg-primary text-primary-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'
          }`}
        >
          <Clock className="size-3.5" />
          <span>Pending Requests ({requests.length})</span>
          {requests.length > 0 && (
            <span
              className={`px-1.5 py-0.2 rounded-full text-[10px] font-bold ${
                activeTab === 'requests'
                  ? 'bg-background text-foreground'
                  : 'bg-amber-500/20 text-amber-500'
              }`}
            >
              {requests.length}
            </span>
          )}
        </button>
      </div>

      <div className="rounded-2xl border bg-card overflow-hidden">
        <div className="border-b px-5 py-3.5 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">
            {activeTab === 'accounts' ? `Accounts (${shownUsers.length})` : `Registration Requests (${shownRequests.length})`}
          </h2>
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by email…"
            className="h-8 w-full max-w-xs text-xs"
            aria-label="Filter accounts by email"
          />
        </div>

        {activeTab === 'accounts' ? (
          isLoading ? (
            <p className="p-8 text-center text-sm text-muted-foreground" role="status">Loading accounts…</p>
          ) : isError ? (
            <div className="p-8 text-center space-y-3" role="alert">
              <p className="text-sm font-medium text-destructive">
                {error?.message || 'Could not load accounts.'}
              </p>
              <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
            </div>
          ) : shownUsers.length === 0 ? (
            <div className="p-8 text-center space-y-2">
              <Users className="size-8 mx-auto text-muted-foreground opacity-50" />
              <p className="text-sm font-medium">
                {users.length === 0 ? 'No accounts yet' : 'No account matches that filter'}
              </p>
              <p className="text-xs text-muted-foreground">
                Invite codes or approved registration requests are how new members get created.
              </p>
            </div>
          ) : (
            <div className="divide-y">
              {shownUsers.map((u) => (
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
                      <span>This month: <strong className="text-foreground">{usageMap.get(u.id)?.requests ?? 0} reqs</strong> ({usageMap.get(u.id)?.tokens ?? 0} tokens)</span>
                      <span className="flex items-center gap-1">
                        Limit: <strong className="text-foreground">{usageMap.get(u.id)?.rpmLimit ?? 60} RPM</strong>
                        {!u.isSelf && (
                          <button
                            type="button"
                            onClick={() => {
                              const current = usageMap.get(u.id)?.rpmLimit ?? 60
                              const input = window.prompt(`Set RPM limit for ${u.email} (1-1000 requests/minute):`, String(current))
                              if (input !== null) {
                                const val = parseInt(input.trim(), 10)
                                if (!isNaN(val) && val >= 1 && val <= 1000) {
                                  quotaMutation.mutate({ id: u.id, rpmLimit: val })
                                } else {
                                  toast.error('Limit must be an integer between 1 and 1000')
                                }
                              }
                            }}
                            className="text-[11px] text-primary hover:underline underline-offset-2 ml-1"
                          >
                            Edit
                          </button>
                        )}
                      </span>
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
          )
        ) : (
          requestsLoading ? (
            <p className="p-8 text-center text-sm text-muted-foreground" role="status">Loading requests…</p>
          ) : requestsError ? (
            <div className="p-8 text-center space-y-3" role="alert">
              <p className="text-sm font-medium text-destructive">
                {reqError?.message || 'Could not load registration requests.'}
              </p>
              <Button variant="outline" size="sm" onClick={() => refetchRequests()}>Retry</Button>
            </div>
          ) : shownRequests.length === 0 ? (
            <div className="p-8 text-center space-y-2">
              <Clock className="size-8 mx-auto text-muted-foreground opacity-50" />
              <p className="text-sm font-medium">
                {requests.length === 0 ? 'No pending requests' : 'No requests match that filter'}
              </p>
              <p className="text-xs text-muted-foreground">
                When prospective users submit access requests without invite codes, they will show up here for your approval.
              </p>
            </div>
          ) : (
            <div className="divide-y">
              {shownRequests.map((r) => (
                <div
                  key={r.id}
                  className="p-4 flex flex-wrap sm:flex-nowrap items-center justify-between gap-4 hover:bg-muted/30 transition-colors"
                >
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground truncate">{r.email}</span>
                      <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                        Pending Approval
                      </span>
                    </div>
                    {r.note && (
                      <div className="flex items-start gap-1.5 text-xs text-muted-foreground bg-muted/30 rounded-lg p-2 border">
                        <FileText className="size-3.5 shrink-0 mt-0.5 text-muted-foreground/70" />
                        <span className="italic">{r.note}</span>
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground">
                      Requested: {new Date(r.createdAt).toLocaleString()}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      size="sm"
                      onClick={() => approveRequestMutation.mutate(r.id)}
                      disabled={busy}
                      className="text-xs h-8 bg-emerald-600 hover:bg-emerald-700 text-white"
                      title="Approve this account: creates member user and default personal API key"
                    >
                      <Check className="size-3.5 mr-1" />
                      Approve
                    </Button>

                    <ConfirmButton
                      onConfirm={() => rejectRequestMutation.mutate(r.id)}
                      disabled={busy}
                      variant="ghost"
                      size="sm"
                      armedSize="sm"
                      confirmLabel="Confirm reject"
                      className="text-xs h-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      title="Reject this request"
                    >
                      <X className="size-3.5 mr-1" />
                      Reject
                    </ConfirmButton>
                  </div>
                </div>
              ))}
            </div>
          )
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Creating accounts directly without invitation or approval is not allowed to protect system capacity.
      </p>
    </div>
  )
}

export default UsersPage

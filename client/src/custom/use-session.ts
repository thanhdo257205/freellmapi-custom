import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

import type { UserSession, Permission } from '../../../shared/user-access'
export type { UserSession, Permission } from '../../../shared/user-access'
import { useSessionRevision } from './session-state'

export function useUserSession() {
  const revision = useSessionRevision()
  const query = useQuery<UserSession>({
    queryKey: ['user-session', revision],
    queryFn: () => apiFetch<UserSession>('/api/user/session'),
    staleTime: 60_000,
    retry: false,
  })

  const session = query.data
  const isPrimary = Boolean(session?.isPrimary)
  const isAdmin = session?.role === 'admin'
  const isMember = session?.role === 'member'
  const permissions = session?.permissions ?? []

  const hasPermission = (permission: Permission): boolean => {
    if (isPrimary || isAdmin) return true
    if (permissions.includes('*')) return true
    return permissions.includes(permission)
  }

  return {
    ...query,
    session,
    isPrimary,
    isAdmin,
    isMember,
    permissions,
    hasPermission,
  }
}

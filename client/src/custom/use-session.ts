import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

import type { UserSession } from '../../../shared/user-access'
export type { UserSession } from '../../../shared/user-access'
import { useSessionRevision } from './session-state'

export function useUserSession() {
  const revision = useSessionRevision()
  const query = useQuery<UserSession>({
    queryKey: ['user-session', revision],
    queryFn: () => apiFetch<UserSession>('/api/user/session'),
    staleTime: 60_000,
    retry: false,
  })

  return {
    ...query,
    session: query.data,
    isAdmin: query.data?.role === 'admin',
    isMember: query.data?.role === 'member',
  }
}

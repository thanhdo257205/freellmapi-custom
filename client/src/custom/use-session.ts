import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

export interface UserSession {
  userId: number
  email: string
  role: 'admin' | 'member'
}

export function useUserSession() {
  const query = useQuery<UserSession>({
    queryKey: ['user-session'],
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

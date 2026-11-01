import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { getSessionRevision } from './session-state'
import type { ExternalAuthMethods } from '../../../shared/external-auth'

export function useExternalAuthMethods() {
  return useQuery<ExternalAuthMethods>({
    queryKey: ['external-auth-methods'],
    queryFn: () => apiFetch('/api/auth/methods'),
    staleTime: 60_000,
    retry: false,
  })
}

type Landing = ({ kind: 'google' } | { kind: 'reset'; token: string }) & {
  revision: number
}
function readLanding(revision: number): Landing | null {
  const url = new URL(window.location.href)
  const fragment = new URLSearchParams(url.hash.slice(1))
  if (fragment.has('reset_token'))
    return { kind: 'reset', token: fragment.get('reset_token')!, revision }
  if (url.searchParams.get('auth') === 'google')
    return { kind: 'google', revision }
  return null
}

export function useExternalAuthLanding(revision: number) {
  const [stored, setStored] = useState<Landing | null>(() =>
    readLanding(revision),
  )
  const landing = stored?.revision === revision ? stored : null
  useEffect(() => {
    const changed = () => {
      const next = readLanding(getSessionRevision())
      if (next) setStored(next)
    }
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [])
  useEffect(() => {
    if (stored && stored.revision !== revision) setStored(null)
  }, [stored, revision])
  useEffect(() => {
    if (!landing) return
    const url = new URL(window.location.href)
    if (landing.kind === 'reset') url.hash = ''
    else url.searchParams.delete('auth')
    window.history.replaceState(
      window.history.state,
      '',
      url.pathname + url.search + url.hash,
    )
  }, [landing])
  return { landing, finishLanding: () => setStored(null) }
}

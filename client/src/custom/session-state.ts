import { useCallback, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'

export const SESSION_CHANGED_EVENT = 'freellmapi:session-changed'
let revision = 0
export const getSessionRevision = () => revision

export function notifySessionChanged() {
  revision += 1
  window.dispatchEvent(new Event(SESSION_CHANGED_EVENT))
}

function subscribe(listener: () => void) {
  window.addEventListener(SESSION_CHANGED_EVENT, listener)
  return () => window.removeEventListener(SESSION_CHANGED_EVENT, listener)
}

export function useSessionRevision() {
  return useSyncExternalStore(subscribe, getSessionRevision, getSessionRevision)
}

/** Erase queries, mutations and component state before another identity renders. */
export function useSessionBoundary() {
  const queryClient = useQueryClient()
  const subscribeToBoundary = useCallback(
    (listener: () => void) =>
      subscribe(() => {
        void queryClient.cancelQueries()
        queryClient.clear()
        listener()
      }),
    [queryClient],
  )
  return useSyncExternalStore(
    subscribeToBoundary,
    getSessionRevision,
    getSessionRevision,
  )
}

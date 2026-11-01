import { useState, useEffect } from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  Shield,
  Key,
  Users,
  Ticket,
  FileCheck,
  ScrollText,
  Settings,
  Database,
  Crown,
} from 'lucide-react'
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import type { AdminUser, Permission } from '../../../shared/user-access'
import { SYSTEM_PERMISSIONS } from '../../../shared/user-access'

interface PermissionMeta {
  key: Permission
  name: string
  description: string
  icon: typeof Key
}

export const PERMISSION_DEFINITIONS: PermissionMeta[] = [
  {
    key: 'manage_keys',
    name: 'Manage Provider Keys',
    description: 'Add, edit, test health, and manage upstream provider keys (OpenAI, Gemini, Groq, etc).',
    icon: Key,
  },
  {
    key: 'manage_users',
    name: 'Manage Users & Roles',
    description: 'Manage accounts, promote/demote members, adjust quotas, and assign permissions (except Primary Admin).',
    icon: Users,
  },
  {
    key: 'manage_invites',
    name: 'Manage Invites',
    description: 'Generate, share, and revoke registration invite codes.',
    icon: Ticket,
  },
  {
    key: 'manage_requests',
    name: 'Review Registration Requests',
    description: 'Approve or reject pending registration requests.',
    icon: FileCheck,
  },
  {
    key: 'view_logs',
    name: 'View Server Logs',
    description: 'Inspect live server logs and debug inference errors.',
    icon: ScrollText,
  },
  {
    key: 'manage_settings',
    name: 'System Settings',
    description: 'Configure proxy routes, system parameters, and client profiles.',
    icon: Settings,
  },
  {
    key: 'manage_backups',
    name: 'Manage Backups',
    description: 'Create and restore full database backups.',
    icon: Database,
  },
]

export function PermissionsDialog({
  user,
  open,
  onOpenChange,
  onSuccess,
}: {
  user: AdminUser | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (user) {
      if (user.isPrimary || user.permissions?.includes('*')) {
        setSelected(new Set(SYSTEM_PERMISSIONS))
      } else {
        setSelected(new Set(user.permissions || []))
      }
    }
  }, [user, open])

  const mutation = useMutation({
    mutationFn: (perms: string[]) =>
      apiFetch<{ success: boolean }>(`/api/admin/users/${user?.id}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ permissions: perms }),
      }),
    onSuccess: () => {
      toast.success('Permissions updated successfully')
      onSuccess()
      onOpenChange(false)
    },
    onError: (err: any) => {
      toast.error(err.message || 'Failed to update permissions')
    },
  })

  if (!user) return null

  const isPrimary = user.isPrimary
  const isAllSelected = SYSTEM_PERMISSIONS.every(p => selected.has(p))

  const toggle = (key: string) => {
    if (isPrimary) return
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  const selectAll = () => {
    if (isPrimary) return
    setSelected(new Set(SYSTEM_PERMISSIONS))
  }

  const clearAll = () => {
    if (isPrimary) return
    setSelected(new Set())
  }

  const handleSave = () => {
    if (isPrimary) {
      onOpenChange(false)
      return
    }
    mutation.mutate(Array.from(selected))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-xl">
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-primary/10 text-primary">
              <Shield className="size-5" />
            </div>
            <div>
              <DialogTitle className="text-lg">User Permissions</DialogTitle>
              <DialogDescription>
                Assign granular access privileges for <strong className="text-foreground">{user.email}</strong>
              </DialogDescription>
            </div>
          </div>

          {isPrimary && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3.5 flex items-center gap-2.5 text-xs text-amber-700 dark:text-amber-400">
              <Crown className="size-4 shrink-0" />
              <span>
                <strong>Primary Admin:</strong> This account holds immutable root authority. Permissions cannot be modified.
              </span>
            </div>
          )}

          {!isPrimary && (
            <div className="flex justify-end gap-2 text-xs">
              <Button type="button" variant="ghost" size="xs" onClick={selectAll} disabled={isAllSelected}>
                Select all
              </Button>
              <Button type="button" variant="ghost" size="xs" onClick={clearAll} disabled={selected.size === 0}>
                Clear all
              </Button>
            </div>
          )}

          <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
            {PERMISSION_DEFINITIONS.map(({ key, name, description, icon: Icon }) => {
              const active = isPrimary || selected.has(key)
              return (
                <label
                  key={key}
                  onClick={() => !isPrimary && toggle(key)}
                  className={`flex items-start gap-3 p-3 rounded-xl border transition-all cursor-pointer ${
                    active
                      ? 'border-primary/40 bg-primary/5 dark:bg-primary/10'
                      : 'border-border hover:bg-muted/40'
                  } ${isPrimary ? 'cursor-not-allowed opacity-80' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={active}
                    disabled={isPrimary}
                    onChange={() => toggle(key)}
                    className="mt-1 size-4 rounded border-muted-foreground/30 text-primary focus:ring-primary shrink-0"
                  />
                  <div className="space-y-0.5 flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Icon className="size-3.5 text-muted-foreground" />
                      <span className="text-xs font-semibold text-foreground">{name}</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">{description}</p>
                  </div>
                </label>
              )
            })}
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {!isPrimary && (
              <Button size="sm" onClick={handleSave} disabled={mutation.isPending}>
                {mutation.isPending ? 'Saving…' : 'Save Permissions'}
              </Button>
            )}
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  )
}


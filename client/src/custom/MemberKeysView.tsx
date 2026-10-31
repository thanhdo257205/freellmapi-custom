import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Key, CheckCircle2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader } from '@/components/page-header'
import { CopyButton } from '@/components/copy-button'
import { toast } from '@/lib/toast'

import type { UserApiKey } from '../../../shared/user-access'
export type { UserApiKey } from '../../../shared/user-access'

export function MemberKeysView() {
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [keyName, setKeyName] = useState('')
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<{ id: number; secret: string } | null>(null)
  const [guideTab, setGuideTab] = useState<'cursor' | 'cline' | 'terminal' | 'python'>('cursor')

  const baseUrl = typeof window !== 'undefined' ? `${window.location.origin}/v1` : 'https://freellm-thanhdo.onrender.com/v1'

  const { data, isLoading } = useQuery<{ keys: UserApiKey[] }>({
    queryKey: ['user-api-keys'],
    queryFn: () => apiFetch<{ keys: UserApiKey[] }>('/api/user/keys'),
  })

  const keys = data?.keys ?? []

  const createKeyMutation = useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ key: { key: string; name: string; id: number } }>('/api/user/keys', {
        method: 'POST',
        body: JSON.stringify({ name: name || 'Default Key' }),
      }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['user-api-keys'] })
      setNewlyCreatedKey({ id: res.key.id, secret: res.key.key })
      setCreateOpen(false)
      setKeyName('')
      toast.success('API Key generated successfully')
    },
    onError: (err: any) => {
      toast.error(err.message || 'Failed to generate key')
    },
  })

  const revokeKeyMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ success: boolean }>(`/api/user/keys/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: (_res, id) => {
      setNewlyCreatedKey(current => current?.id === id ? null : current)
      queryClient.invalidateQueries({ queryKey: ['user-api-keys'] })
      toast.success('API Key revoked')
    },
    onError: (err: any) => {
      toast.error(err.message || 'Failed to revoke key')
    },
  })

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault()
    createKeyMutation.mutate(keyName.trim())
  }

  const handleRevoke = (id: number, name: string) => {
    if (window.confirm(`Are you sure you want to revoke key "${name}"? Any clients using it will immediately lose access.`)) {
      revokeKeyMutation.mutate(id)
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Personal API Keys"
        description="Manage your personal gateway credentials for Cursor, Cline, Claude Code, and other LLM clients."
        actions={
          <Button onClick={() => { setNewlyCreatedKey(null); setCreateOpen(true) }}>
            <Plus className="mr-1.5 size-4" />
            Generate New Key
          </Button>
        }
      />

      {/* Newly minted key banner */}
      {newlyCreatedKey && (
        <div className="rounded-2xl border border-primary/30 bg-primary/5 p-5 shadow-sm space-y-3">
          <div className="flex items-center gap-2 text-primary font-medium text-sm">
            <CheckCircle2 className="size-4" />
            <span>Key Created Successfully</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Please copy this key now. For your security, it will never be displayed again.
          </p>
          <div className="flex items-center gap-2">
            <div className="flex-1 font-mono text-xs bg-background/80 border rounded-lg px-3 py-2 text-foreground break-all select-all">
              {newlyCreatedKey.secret}
            </div>
            <CopyButton text={newlyCreatedKey.secret} label="Copy API key" className="h-9 px-3" />
          </div>
        </div>
      )}

      {/* Keys List */}
      <div className="rounded-2xl border bg-card overflow-hidden">
        <div className="border-b px-5 py-3.5 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Active Keys ({keys.filter(key => !key.revoked).length})</h2>
        </div>

        {isLoading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Loading keys…</div>
        ) : keys.length === 0 ? (
          <div className="p-8 text-center space-y-2">
            <Key className="size-8 mx-auto text-muted-foreground opacity-50" />
            <p className="text-sm font-medium">No API keys yet</p>
            <p className="text-xs text-muted-foreground">
              Generate an API key to start querying FreeLLMAPI with your favorite coding assistant.
            </p>
          </div>
        ) : (
          <div className="divide-y">
            {keys.map((k) => (
              <div key={k.id} className="p-4 flex flex-wrap sm:flex-nowrap items-center justify-between gap-4 hover:bg-muted/30 transition-colors">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm text-foreground">{k.name}</span>
                    <span className="font-mono text-xs text-muted-foreground bg-muted/60 px-2 py-0.5 rounded">
                      {k.keyPrefix}••••••••
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground flex gap-4">
                    <span>Created: {new Date(k.createdAt).toLocaleDateString()}</span>
                    <span>Last used: {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : 'Never'}</span>
                  </div>
                </div>
                {k.revoked ? <span className="text-xs text-muted-foreground">Revoked</span> : <Button
                  disabled={revokeKeyMutation.isPending}
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRevoke(k.id, k.name)}
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive text-xs shrink-0"
                >
                  <Trash2 className="size-3.5 mr-1" />
                  Revoke
                </Button>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Quick Setup Guide */}
      <div className="rounded-2xl border bg-card p-6 space-y-5">
        <div>
          <h2 className="text-base font-semibold">Client Setup Guide</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Configure your AI assistant or IDE extension using your personal gateway key.
          </p>
        </div>

        {/* Base URL bar */}
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">OpenAI Compatible Base URL</Label>
          <div className="flex items-center gap-2 max-w-lg">
            <div className="flex-1 font-mono text-xs bg-muted/60 border rounded-lg px-3 py-2 text-foreground">
              {baseUrl}
            </div>
            <CopyButton text={baseUrl} label="Copy Base URL" className="h-9 px-3" />
          </div>
        </div>

        {/* Tab switcher */}
        <div className="flex gap-2 border-b pb-2 text-xs">
          {(['cursor', 'cline', 'terminal', 'python'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setGuideTab(tab)}
              className={`px-3 py-1.5 rounded-lg font-medium transition-colors ${
                guideTab === tab
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab === 'cursor' && 'Cursor IDE'}
              {tab === 'cline' && 'Cline / Roo Code'}
              {tab === 'terminal' && 'Claude Code / Terminal'}
              {tab === 'python' && 'Python / OpenAI SDK'}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="text-xs space-y-3 font-mono bg-muted/40 p-4 rounded-xl border">
          {guideTab === 'cursor' && (
            <div className="space-y-2">
              <p className="font-sans text-muted-foreground">1. Open <strong>Cursor Settings</strong> → <strong>Models</strong>.</p>
              <p className="font-sans text-muted-foreground">2. Turn off other providers or enable <strong>OpenAI API Key</strong>.</p>
              <p className="font-sans text-muted-foreground">3. Click <strong>Override OpenAI Base URL</strong> and enter:</p>
              <div className="flex items-center justify-between bg-card p-2.5 rounded border">
                <span>{baseUrl}</span>
                <CopyButton text={baseUrl} />
              </div>
              <p className="font-sans text-muted-foreground">4. Paste your <strong>Personal API Key</strong> into the OpenAI API Key box.</p>
            </div>
          )}

          {guideTab === 'cline' && (
            <div className="space-y-2">
              <p className="font-sans text-muted-foreground">1. Open <strong>Cline</strong> settings in VS Code.</p>
              <p className="font-sans text-muted-foreground">2. Select <strong>API Provider</strong>: <code>OpenAI Compatible</code>.</p>
              <p className="font-sans text-muted-foreground">3. Set <strong>Base URL</strong>:</p>
              <div className="flex items-center justify-between bg-card p-2.5 rounded border">
                <span>{baseUrl}</span>
                <CopyButton text={baseUrl} />
              </div>
              <p className="font-sans text-muted-foreground">4. Paste your <strong>Personal API Key</strong> into <strong>API Key</strong>.</p>
            </div>
          )}

          {guideTab === 'terminal' && (
            <div className="space-y-2">
              <p className="font-sans text-muted-foreground">Export these environment variables in your terminal:</p>
              <div className="bg-card p-3 rounded border space-y-1">
                <p>export OPENAI_BASE_URL="{baseUrl}"</p>
                <p>export OPENAI_API_KEY="sk-flm-your-key-here"</p>
              </div>
              <CopyButton text={`export OPENAI_BASE_URL="${baseUrl}"\nexport OPENAI_API_KEY="sk-flm-your-key-here"`} label="Copy export commands" />
            </div>
          )}

          {guideTab === 'python' && (
            <div className="space-y-2">
              <div className="bg-card p-3 rounded border">
                <pre className="text-muted-foreground">
{`from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}",
    api_key="sk-flm-your-key-here"
)

response = client.chat.completions.create(
    model="llama-3.3-70b-versatile",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)`}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Create Key Modal Dialog */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-3xl border bg-card p-6 shadow-xl space-y-4">
            <h3 className="text-base font-semibold">Generate New API Key</h3>
            <p className="text-xs text-muted-foreground">
              Give your key a descriptive label so you can track which device or project is using it.
            </p>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="key-name" className="text-xs">Key Name / Label</Label>
                <Input
                  id="key-name"
                  type="text"
                  placeholder="e.g. Cursor MacBook Pro"
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createKeyMutation.isPending}>
                  {createKeyMutation.isPending ? 'Generating…' : 'Generate'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

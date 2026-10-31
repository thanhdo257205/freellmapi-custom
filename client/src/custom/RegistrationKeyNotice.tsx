import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'

export function RegistrationKeyNotice({
  apiKey,
  onContinue,
}: {
  apiKey: string
  onContinue: () => void
}) {
  return (
    <div className="rounded-3xl border bg-card p-6 space-y-4">
      <h1 className="text-lg font-semibold">Save your personal API key</h1>
      <p className="text-sm text-muted-foreground">
        Your account is ready. Copy this key now: it is shown only once and
        cannot be recovered later. You can revoke it or create another key in
        Keys.
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all select-all text-xs">
          {apiKey}
        </code>
        <CopyButton text={apiKey} label="Copy API key" />
      </div>
      <Button onClick={onContinue}>Continue to dashboard</Button>
    </div>
  )
}

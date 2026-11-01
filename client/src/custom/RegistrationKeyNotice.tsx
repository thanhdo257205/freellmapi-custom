import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

export function RegistrationKeyNotice({
  apiKey,
  onContinue,
}: {
  apiKey: string
  onContinue: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="rounded-3xl border bg-card p-6 space-y-4">
      <h1 className="text-lg font-semibold">{t('auth.saveApiKey')}</h1>
      <p className="text-sm text-muted-foreground">
        {t('auth.saveApiKeyHint')}
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all select-all text-xs">
          {apiKey}
        </code>
        <CopyButton text={apiKey} label={t('auth.copyApiKey')} />
      </div>
      <Button onClick={onContinue}>{t('auth.continueToDashboard')}</Button>
    </div>
  )
}

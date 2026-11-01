import { useState, type ComponentProps } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { useI18n } from '@/i18n'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

function PasswordInput(props: Omit<ComponentProps<typeof Input>, 'type'>) {
  const [visible, setVisible] = useState(false)
  const { t } = useI18n()
  const toggleLabel = visible ? t('common.hidePassword') : t('common.showPassword')

  return (
    <div className="relative">
      <Input {...props} type={visible ? 'text' : 'password'} className={cn('pr-9', props.className)} />
      <button
        type="button"
        aria-label={toggleLabel}
        title={toggleLabel}
        aria-pressed={visible}
        onMouseDown={e => e.preventDefault()}
        onClick={() => setVisible(value => !value)}
        className="absolute inset-y-0 right-1 inline-flex w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {visible ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
      </button>
    </div>
  )
}

export { PasswordInput }

import { Eye, EyeOff } from 'lucide-react'
import * as React from 'react'
import { Input, type InputProps } from '@/components/ui'

/** Password field with show/hide toggle. */
export const PasswordInput = React.forwardRef<HTMLInputElement, Omit<InputProps, 'type' | 'trailing'>>(function PasswordInput(props, ref) {
  const [show, setShow] = React.useState(false)
  return (
    <Input
      ref={ref}
      type={show ? 'text' : 'password'}
      spellCheck={false}
      autoCapitalize="off"
      inputSize="lg"
      {...props}
      trailing={
        <button
          type="button"
          tabIndex={-1}
          aria-label={show ? '隐藏密码' : '显示密码'}
          onClick={() => setShow(!show)}
          className="flex size-7 items-center justify-center rounded-md text-tertiary-label hover:text-secondary-label pointer-coarse:size-10"
        >
          {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      }
    />
  )
})

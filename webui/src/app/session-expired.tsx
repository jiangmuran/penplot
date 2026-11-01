import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { useLogin } from '@/api/auth'
import { isApiError } from '@/api/client'
import { Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField } from '@/components/ui'
import { PasswordInput } from './auth/password-input'
import { useUi } from './ui-store'

/** Re-login in place when the session expires, keeping unsaved page state (02-ux §3.12). */
export function SessionExpiredDialog() {
  const open = useUi((s) => s.sessionExpired)
  const set = useUi((s) => s.set)
  const login = useLogin()
  const navigate = useNavigate()
  const [pw, setPw] = React.useState('')
  const err = login.error
  const msg = !err ? null : isApiError(err) && err.status === 401 ? '用户名或密码不正确' : isApiError(err) && err.status === 429 ? `尝试过多，请 ${err.retryAfter ?? 60} 秒后再试` : err.message
  return (
    <Dialog open={open} onOpenChange={(o) => !o && set({ sessionExpired: false })}>
      <DialogContent size="sm" hideClose onInteractOutside={(e) => e.preventDefault()}>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            login.mutate({ username: localStorage.getItem('penplot.lastUser') || undefined, password: pw }, { onSuccess: () => (setPw(''), set({ sessionExpired: false })) })
          }}
        >
          <DialogHeader className="pr-5">
            <DialogTitle>登录已过期</DialogTitle>
            <DialogDescription>重新输入密码以继续，当前页面的编辑内容会保留。</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <input type="text" name="username" autoComplete="username" value={localStorage.getItem('penplot.lastUser') || 'admin'} readOnly hidden />
            <FormField label="密码" htmlFor="relogin-pw" error={msg}>
              <PasswordInput id="relogin-pw" autoFocus value={pw} onChange={(e) => setPw(e.currentTarget.value)} invalid={!!msg} autoComplete="current-password" />
            </FormField>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="gray"
              onClick={() => {
                set({ sessionExpired: false })
                navigate('/login')
              }}
            >
              前往登录页
            </Button>
            <Button type="submit" variant="filled" loading={login.isPending} disabled={!pw}>
              登录
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

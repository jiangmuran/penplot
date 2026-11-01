import * as React from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuthState, useLogin } from '@/api/auth'
import { isApiError } from '@/api/client'
import { Button, FormField, Input } from '@/components/ui'
import { AuthLayout } from './auth-layout'
import { PasswordInput } from './password-input'

function safeNext(n: string | null) {
  return n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/login') && !n.startsWith('/setup') ? n : '/'
}

export default function LoginPage() {
  const auth = useAuthState()
  const login = useLogin()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  const [pw, setPw] = React.useState('')
  const [user, setUser] = React.useState(() => localStorage.getItem('penplot.lastUser') ?? '')
  const [shake, setShake] = React.useState(0)
  const [lockedUntil, setLockedUntil] = React.useState<number | null>(null)
  const [now, setNow] = React.useState(Date.now())
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (!lockedUntil) return
    const t = setInterval(() => {
      setNow(Date.now())
      if (Date.now() >= lockedUntil) setLockedUntil(null)
    }, 500)
    return () => clearInterval(t)
  }, [lockedUntil])

  if (auth.data?.setup_required) return <Navigate to="/setup" replace />
  if (auth.data?.authenticated) return <Navigate to={next} replace />

  const remaining = lockedUntil ? Math.max(0, Math.ceil((lockedUntil - now) / 1000)) : 0
  const err = login.error
  let message: string | null = null
  if (remaining > 0) message = `尝试次数过多，请 ${remaining} 秒后再试`
  else if (err && isApiError(err)) {
    if (err.status === 401) message = '用户名或密码不正确'
    else if (err.status === 429) message = null
    else if (err.isOffline) message = '无法连接到设备，请检查网络'
    else message = err.message
  } else if (err) message = err.message

  return (
    <AuthLayout title="PenPlot" subtitle={`写字机工作台 · ${location.hostname}`} shake={shake}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (!pw || remaining) return
          login.mutate({ username: user || undefined, password: pw }, {
            onSuccess: () => navigate(next, { replace: true }),
            onError: (e) => {
              setShake((n) => n + 1)
              if (isApiError(e) && e.status === 429) setLockedUntil(Date.now() + (e.retryAfter ?? 60) * 1000)
              setPw('')
              requestAnimationFrame(() => inputRef.current?.focus())
            },
          })
        }}
      >
        <FormField label="用户名" htmlFor="username" help={user ? undefined : '留空则以管理员身份登录'}>
          <Input
            id="username"
            name="username"
            inputSize="lg"
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="admin"
            value={user}
            onChange={(e) => setUser(e.currentTarget.value)}
          />
        </FormField>
        <FormField label="密码" htmlFor="password" error={message}>
          <PasswordInput
            ref={inputRef}
            id="password"
            name="password"
            autoFocus={!!user}
            autoComplete="current-password"
            placeholder="输入密码"
            value={pw}
            invalid={!!message}
            aria-describedby={message ? 'password-error' : undefined}
            onChange={(e) => setPw(e.currentTarget.value)}
          />
        </FormField>
        <Button type="submit" variant="filled" size="xl" block loading={login.isPending} disabled={!pw || remaining > 0}>
          登录
        </Button>
        {auth.isError ? <p className="text-center text-footnote text-on-tint-orange">暂时无法连接到设备服务，可稍后重试。</p> : null}
      </form>
    </AuthLayout>
  )
}

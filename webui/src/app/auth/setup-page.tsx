import { KeyRound } from 'lucide-react'
import * as React from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuthState, useSetup } from '@/api/auth'
import { isApiError } from '@/api/client'
import { Button, FormField, Input } from '@/components/ui'
import { AuthLayout } from './auth-layout'
import { PasswordInput } from './password-input'

/** First run: setup code (from the board) + admin password (≥10 chars). */
export default function SetupPage() {
  const auth = useAuthState()
  const setup = useSetup()
  const navigate = useNavigate()
  const [code, setCode] = React.useState('')
  const [username, setUsername] = React.useState('admin')
  const [displayName, setDisplayName] = React.useState('')
  const [pw, setPw] = React.useState('')
  const [pw2, setPw2] = React.useState('')
  const [touched, setTouched] = React.useState(false)
  const [shake, setShake] = React.useState(0)

  if (auth.data && !auth.data.setup_required) return <Navigate to={auth.data.authenticated ? '/' : '/login'} replace />

  const needCode = auth.data?.setup_code_required ?? true
  const pwErr = touched && pw.length > 0 && pw.length < 10 ? '密码至少 10 个字符' : null
  const pw2Err = touched && pw2.length > 0 && pw !== pw2 ? '两次输入的密码不一致' : null
  const err = setup.error
  const codeErr = err && isApiError(err) && (err.code.includes('code') || err.status === 403 || err.status === 401) ? '设置码不正确' : null
  const otherErr = err && !codeErr ? (isApiError(err) && err.isOffline ? '无法连接到设备' : err.message) : null
  const valid = (!needCode || code.trim().length > 0) && pw.length >= 10 && pw === pw2 && /^[\w.-]{1,32}$/.test(username.trim() || 'admin')

  return (
    <AuthLayout title="欢迎使用 PenPlot" subtitle="创建管理员账户以开始使用" shake={shake}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          setTouched(true)
          if (!valid) return
          setup.mutate(
            { setup_code: code.trim(), password: pw, username: username.trim() || 'admin', display_name: displayName.trim() || undefined },
            { onSuccess: () => navigate('/', { replace: true }), onError: () => setShake((n) => n + 1) },
          )
        }}
      >
        {needCode ? (
          <FormField
            label="设置码"
            htmlFor="setup-code"
            error={codeErr}
            help={
              <>
                8 位数字，位于设备的 <code className="font-mono">/var/lib/penplot/setup-code</code>，或执行 <code className="font-mono">journalctl -u penplot-web</code> 查看。
              </>
            }
          >
            <Input
              id="setup-code"
              inputSize="lg"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              leading={<KeyRound />}
              placeholder="12345678"
              maxLength={16}
              className="font-mono tracking-[0.2em]"
              value={code}
              invalid={!!codeErr}
              onChange={(e) => setCode(e.currentTarget.value.replace(/\s/g, ''))}
            />
          </FormField>
        ) : null}
        <FormField label="管理员用户名" htmlFor="admin-user" help="以后登录用；其他租户成员的账号可以在 设置 › 用户 里另外添加。">
          <Input id="admin-user" inputSize="lg" autoComplete="username" autoCapitalize="off" spellCheck={false} value={username} onChange={(e) => setUsername(e.currentTarget.value)} />
        </FormField>
        <FormField label="显示名称（可选）" htmlFor="admin-name">
          <Input id="admin-name" inputSize="lg" placeholder="例如：前台管理员" value={displayName} onChange={(e) => setDisplayName(e.currentTarget.value)} />
        </FormField>
        <FormField label="新密码" htmlFor="new-pw" error={pwErr} help="至少 10 个字符">
          <PasswordInput id="new-pw" autoComplete="new-password" value={pw} invalid={!!pwErr} onChange={(e) => setPw(e.currentTarget.value)} onBlur={() => setTouched(true)} autoFocus={!needCode} />
        </FormField>
        <FormField label="确认密码" htmlFor="new-pw2" error={pw2Err}>
          <PasswordInput id="new-pw2" autoComplete="new-password" value={pw2} invalid={!!pw2Err} onChange={(e) => setPw2(e.currentTarget.value)} onBlur={() => setTouched(true)} />
        </FormField>
        {otherErr ? <p role="alert" className="text-footnote text-red">{otherErr}</p> : null}
        <Button type="submit" variant="filled" size="xl" block loading={setup.isPending} disabled={!valid}>
          创建并登录
        </Button>
      </form>
    </AuthLayout>
  )
}

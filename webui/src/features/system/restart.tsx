/** 重启服务: confirm → POST /system/restart → full-screen overlay polling /system/health until back. */
import { ArrowUpToLine, CircleCheck, Crosshair, ListRestart, RotateCw, TriangleAlert } from 'lucide-react'
import * as React from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { useNavigate } from 'react-router-dom'
import { api } from '@/api/client'
import { penUp } from '@/api/machine'
import { useLive } from '@/api/store'
import { queryClient } from '@/api/query'
import { restartService, type Health } from '@/api/system'
import { Button, Spinner } from '@/components/ui'
import { confirm } from '@/lib/confirm'
import { toast } from '@/lib/toast'
import { errParts } from '../projects/ext'

type Phase = 'idle' | 'restarting' | 'back' | 'slow'

/** Module-level so the overlay survives the page remounting while the app re-syncs after a restart. */
const useRestartStore = create<{ phase: Phase; elapsed: number }>(() => ({ phase: 'idle', elapsed: 0 }))
const setPhase = (phase: Phase) => useRestartStore.setState({ phase })
const setElapsed = (elapsed: number) => useRestartStore.setState({ elapsed })

export function useRestart() {
  const { phase, elapsed } = useRestartStore()

  const start = async () => {
    const ok = await confirm({
      title: '重启 PenPlot 服务？',
      description: '页面会断开大约 30 秒，然后自动重新连接。控制板也会跟着复位，原点会丢失，之后要抬笔并重新设原点。',
      confirmLabel: '重启',
      destructive: true,
    })
    if (!ok) return
    let before: number | null = null
    try {
      before = (await api.get<Health>('/system/health', { timeoutMs: 3000 })).uptime_s
      await restartService()
    } catch (e) {
      const m = errParts(e, '没能重启服务')
      toast.error(m.title, { description: m.description })
      return
    }
    setPhase('restarting')
    setElapsed(0)
    const t0 = Date.now()
    let sawDown = false
    const tick = async () => {
      const sec = (Date.now() - t0) / 1000
      setElapsed(sec)
      try {
        const h = await api.get<Health>('/system/health', { timeoutMs: 2500, skipAuthHandling: true })
        // back when we saw it go down, or the uptime counter restarted
        if (sawDown || (before != null && h.uptime_s < before)) {
          setPhase('back')
          void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'auth' })
          return
        }
      } catch {
        sawDown = true
      }
      if (sec > 120) {
        setPhase('slow')
        return
      }
      setTimeout(tick, 2000)
    }
    setTimeout(tick, 2500)
  }

  const overlay =
    phase === 'idle'
      ? null
      : createPortal(
          <div
            role="alertdialog"
            aria-modal="true"
            aria-live="assertive"
            aria-label="正在重启服务"
            className="mat-thick fixed inset-0 z-[60] flex animate-fade-in flex-col items-center justify-center gap-4 overflow-y-auto p-6 text-center"
          >
            {phase === 'restarting' ? (
              <>
                <Spinner size={40} />
                <h2 className="text-title2 text-label">正在重启，约 30 秒…</h2>
                <p className="text-subheadline tabular-nums text-secondary-label">已等待 {Math.round(elapsed)} 秒，服务恢复后自动重新连接</p>
              </>
            ) : phase === 'back' ? (
              <Recovery onClose={() => setPhase('idle')} />
            ) : (
              <>
                <TriangleAlert className="size-12 text-orange" strokeWidth={1.75} />
                <h2 className="text-title2 text-label">重启时间比预期长</h2>
                <p className="max-w-sm text-subheadline text-secondary-label">设备可能仍在启动，或服务未能恢复。请检查设备电源与网络，或通过 SSH 查看 systemctl status penplot-web。</p>
                <div className="flex gap-2">
                  <Button onClick={() => setPhase('idle')}>关闭</Button>
                  <Button variant="filled" icon={<RotateCw />} onClick={() => location.reload()}>
                    重新加载页面
                  </Button>
                </div>
              </>
            )}
          </div>,
          document.body,
        )

  return { start, overlay, busy: phase !== 'idle' }
}

/** After a restart the controller was reset: pen up → back to origin (if still valid) → resume in /jobs. */
function Recovery({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const machine = useLive((s) => s.machine)
  const connected = !!machine?.connected
  const originValid = !!machine?.origin_valid
  const [done, setDone] = React.useState<{ up?: boolean; home?: boolean }>({})
  const [busy, setBusy] = React.useState<'up' | 'home' | null>(null)
  const run = async (k: 'up' | 'home') => {
    setBusy(k)
    try {
      if (k === 'up') await penUp()
      else await api.post('/machine/goto-origin', {})
      setDone((d) => ({ ...d, [k]: true }))
    } catch (e) {
      const m = errParts(e, k === 'up' ? '没能抬笔' : '没能回到原点')
      toast.error(m.title, { description: m.description })
    } finally {
      setBusy(null)
    }
  }
  const go = (to: string) => {
    onClose()
    navigate(to)
  }
  return (
    <div className="flex w-full max-w-md flex-col items-stretch gap-4 text-left">
      <div className="flex flex-col items-center gap-2 text-center">
        <CircleCheck className="size-12 text-green" strokeWidth={1.75} aria-hidden />
        <h2 className="text-title2 text-label">服务已恢复</h2>
        <p className="text-subheadline text-secondary-label">控制板刚才也复位了。按下面的顺序把机器恢复到可以继续写的状态。</p>
      </div>
      <ol className="flex flex-col overflow-hidden rounded-lg bg-bg-grouped-secondary shadow-sm [&>*+*]:hairline-t">
        <Step n={1} icon={ArrowUpToLine} title="抬笔" desc={connected ? '先把笔抬起来，避免移动时划到纸。' : '机器还没连上，连上后再抬笔。'} ok={done.up}>
          <Button size="sm" loading={busy === 'up'} disabled={!connected || !!busy} onClick={() => run('up')}>
            抬笔
          </Button>
        </Step>
        <Step
          n={2}
          icon={Crosshair}
          title="回到原点"
          desc={originValid ? '原点还在，笔会回到开始写字的位置。' : '原点已经丢失：到「控制」把笔移到要写内容的左上角，再设为原点。'}
          ok={done.home}
        >
          {originValid ? (
            <Button size="sm" loading={busy === 'home'} disabled={!connected || !!busy} onClick={() => run('home')}>
              回到原点
            </Button>
          ) : (
            <Button size="sm" onClick={() => go('/machine')}>
              去设原点
            </Button>
          )}
        </Step>
        <Step n={3} icon={ListRestart} title="续写" desc="被打断的任务可以在「任务」里从中断的那一行继续写。">
          <Button size="sm" onClick={() => go('/jobs')}>
            打开任务
          </Button>
        </Step>
      </ol>
      <Button variant="filled" size="lg" onClick={onClose}>
        完成
      </Button>
    </div>
  )
}

function Step({ n, icon: Icon, title, desc, ok, children }: { n: number; icon: typeof CircleCheck; title: string; desc: string; ok?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex min-h-14 items-center gap-3 px-4 py-2.5">
      <span className={ok ? 'flex size-7 shrink-0 items-center justify-center rounded-full bg-green text-white' : 'flex size-7 shrink-0 items-center justify-center rounded-full bg-fill text-footnote font-semibold text-secondary-label'}>
        {ok ? <CircleCheck className="size-4" aria-label="已完成" /> : n}
      </span>
      <Icon className="size-5 shrink-0 text-accent" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-body text-label">{title}</p>
        <p className="text-footnote text-secondary-label">{desc}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </li>
  )
}

/**
 * Drop-in settings group for reminders (设置 › 通用 › 提醒). Pages can embed it:
 *   import { AttentionSettings } from '@/app/attention-settings'
 */
import { Bell, Smartphone, Sun, Volume2 } from 'lucide-react'
import * as React from 'react'
import { Button, GroupedList, ListRow, Switch } from '@/components/ui'
import {
  isIOS, isStandalone, notificationState, playTone, requestNotifications, setAttentionPrefs, useAttentionPrefs, type NotifyState,
} from '@/lib/attention'

export function AttentionSettings({ className }: { className?: string }) {
  const prefs = useAttentionPrefs()
  const [perm, setPerm] = React.useState<NotifyState>(notificationState())
  const secure = window.isSecureContext
  const ios = isIOS()
  const standalone = isStandalone()
  const hasWakeLock = 'wakeLock' in navigator

  let notifyHelp: string
  if (!secure) notifyHelp = '浏览器只允许 HTTPS 或本机地址发送通知。通过局域网 HTTP 访问时，请依靠提示音和标签页标题提醒。'
  else if (perm === 'unsupported') notifyHelp = ios && !standalone ? 'iPhone / iPad 需要先「添加到主屏幕」，从主屏幕打开后才能收到通知。' : '此浏览器不支持系统通知。'
  else if (perm === 'denied') notifyHelp = '通知已被浏览器阻止，请在浏览器的网站设置里允许通知。'
  else if (perm === 'default') notifyHelp = '写完、需要换纸或出错时，即使切到其他标签页也会提醒你。'
  else notifyHelp = '页面不在前台时发送系统通知。'

  return (
    <div className={className}>
      <GroupedList header="提醒" footer={notifyHelp}>
        <ListRow
          icon={Volume2}
          iconColor="bg-pink"
          label="提示音"
          subtitle="写完、换纸、出错使用不同的声音"
          accessory={<Switch checked={prefs.sound} onCheckedChange={(v) => setAttentionPrefs({ sound: v })} aria-label="提示音" />}
        />
        {prefs.sound ? (
          <div className="flex flex-wrap gap-2 px-4 py-2">
            <Button size="sm" variant="gray" onClick={() => playTone('done')}>试听：写完</Button>
            <Button size="sm" variant="gray" onClick={() => playTone('paper')}>试听：换纸</Button>
            <Button size="sm" variant="gray" onClick={() => playTone('error')}>试听：出错</Button>
          </div>
        ) : null}
        <ListRow
          icon={Bell}
          iconColor="bg-red"
          label="系统通知"
          accessory={
            perm === 'default' && secure ? (
              <Button size="sm" variant="tinted" onClick={async () => setPerm(await requestNotifications())}>
                允许通知
              </Button>
            ) : perm === 'granted' ? (
              <Switch checked={prefs.notify} onCheckedChange={(v) => setAttentionPrefs({ notify: v })} aria-label="系统通知" />
            ) : (
              <span className="text-footnote text-secondary-label">{perm === 'denied' ? '已阻止' : '不可用'}</span>
            )
          }
        />
        {'vibrate' in navigator ? (
          <ListRow
            icon={Smartphone}
            iconColor="bg-gray"
            label="振动"
            accessory={<Switch checked={prefs.vibrate} onCheckedChange={(v) => setAttentionPrefs({ vibrate: v })} aria-label="振动" />}
          />
        ) : null}
        {hasWakeLock ? (
          <ListRow
            icon={Sun}
            iconColor="bg-orange"
            label="写字时保持屏幕常亮"
            subtitle="页面在前台时，避免锁屏导致连接中断"
            accessory={<Switch checked={prefs.wakeLock} onCheckedChange={(v) => setAttentionPrefs({ wakeLock: v })} aria-label="写字时保持屏幕常亮" />}
          />
        ) : null}
      </GroupedList>
      {ios && !standalone ? (
        <p className="mt-3 px-4 text-footnote text-secondary-label">
          提示：在 Safari 中点「分享」→「添加到主屏幕」，PenPlot 就能像 App 一样全屏打开。
        </p>
      ) : null}
    </div>
  )
}

import { Compass } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button, EmptyState } from '@/components/ui'
import { Page } from './page'

export function NotFoundPage() {
  return (
    <Page title="未找到">
      <EmptyState
        icon={Compass}
        title="页面不存在"
        description="链接可能已失效，或页面已被移动。"
        action={
          <Button variant="filled" asChild>
            <Link to="/studio">回到创作台</Link>
          </Button>
        }
      />
    </Page>
  )
}

import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router-dom'
import { queryClient } from '@/api/query'
import { ConfirmHost, Toaster, TooltipProvider } from '@/components/ui'
import { router } from './router'
import './import-handlers'

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
        <Toaster />
        <ConfirmHost />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

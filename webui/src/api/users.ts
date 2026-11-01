/**
 * User management hooks (pages-agent addition). ASSUMED contract — see ./collab.ts header.
 * Every caller treats 404/405/501 as "尚不可用（后端尚未提供）".
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from './client'
import { collabKeys, type Me, type Role, type UserInfo } from './collab'
import { queryClient } from './query'

export interface UserCreate {
  username: string
  display_name?: string | null
  password: string
  role: Role
}
export interface UserPatch {
  display_name?: string | null
  role?: Role
  disabled?: boolean
}

const invalidate = () => {
  void queryClient.invalidateQueries({ queryKey: collabKeys.users })
  void queryClient.invalidateQueries({ queryKey: collabKeys.me })
}

export const useUsers = (enabled = true) =>
  useQuery({ queryKey: collabKeys.users, queryFn: () => api.get<UserInfo[]>('/users'), enabled, retry: false })

export function useCreateUser() {
  return useMutation({
    mutationFn: (b: UserCreate) => api.post<UserInfo>('/users', b),
    meta: { errorTitle: '创建用户失败' },
    onSuccess: invalidate,
  })
}
export function useUpdateUser() {
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UserPatch }) => api.patch<UserInfo>(`/users/${encodeURIComponent(id)}`, patch),
    meta: { errorTitle: '更新用户失败' },
    onSuccess: invalidate,
  })
}
export function useDeleteUser() {
  return useMutation({
    mutationFn: (id: string) => api.delete(`/users/${encodeURIComponent(id)}`),
    meta: { errorTitle: '删除用户失败' },
    onSuccess: invalidate,
  })
}
export function resetUserPassword(id: string, password: string) {
  return api.post(`/users/${encodeURIComponent(id)}/password`, { new: password })
}
/** Update the current user's own display name. */
export function updateMe(me: Me, patch: Pick<UserPatch, 'display_name'>) {
  return api.patch<UserInfo>(`/users/${encodeURIComponent(me.id)}`, patch).then((u) => {
    invalidate()
    return u
  })
}

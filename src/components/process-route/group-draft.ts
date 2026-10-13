import { useState } from 'react'

import { GROUP_COLORS } from './process-utils'

export interface GroupDraft {
  name: string
  color: string
  target: string
}

export const useGroupDraft = (initial: Partial<GroupDraft>) => {
  const [draft, setDraft] = useState<GroupDraft>(() => ({
    name: initial.name ?? '',
    color: initial.color ?? GROUP_COLORS[0],
    target: initial.target ?? '',
  }))
  return [draft, setDraft] as const
}

export const isDraftValid = (
  draft: GroupDraft,
  groups: IProcessRouteGroup[],
  editingId?: string,
) => {
  const name = draft.name.trim()
  return (
    !!name &&
    !name.includes(',') &&
    !groups.some((group) => group.id !== editingId && group.name === name)
  )
}

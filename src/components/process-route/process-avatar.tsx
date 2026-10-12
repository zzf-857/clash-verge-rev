import { FolderRounded } from '@mui/icons-material'
import { Box } from '@mui/material'

import { avatarColor, displayName } from './process-utils'

interface Props {
  name: string
  size?: number
  folder?: boolean
}

export const ProcessAvatar = ({ name, size = 32, folder }: Props) => {
  const label = displayName(name)
  const color = avatarColor(label)
  return (
    <Box
      aria-hidden
      sx={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: size >= 40 ? 2.5 : 1.75,
        display: 'grid',
        placeItems: 'center',
        color: '#fff',
        fontWeight: 700,
        fontSize: size * 0.42,
        letterSpacing: 0,
        textTransform: 'uppercase',
        background: `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 70%, #000))`,
        boxShadow: `inset 0 0 0 1px rgba(255,255,255,0.18)`,
        userSelect: 'none',
      }}
    >
      {folder ? (
        <FolderRounded sx={{ fontSize: size * 0.55 }} />
      ) : (
        label.charAt(0) || '?'
      )}
    </Box>
  )
}

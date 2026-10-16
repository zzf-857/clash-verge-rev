import { AltRouteRounded } from '@mui/icons-material'
import { Box, Chip, Typography } from '@mui/material'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { useConnectionData } from '@/hooks/use-connection-data'
import { useProfiles } from '@/hooks/use-profiles'
import { useSystemState } from '@/hooks/use-system-state'
import { useVerge } from '@/hooks/use-verge'
import { useClashConfigData } from '@/providers/app-data-context'
import parseTraffic from '@/utils/parse-traffic'

import { buildFlow } from './build-flow'
import { FlowGraph } from './flow-graph'

const formatSpeed = (value: number) => `${parseTraffic(value).join(' ')}/s`

export const FlowOverview = () => {
  const { t } = useTranslation()
  const { verge } = useVerge()
  const { isTunModeAvailable } = useSystemState()
  const { clashConfig } = useClashConfigData()
  const { current } = useProfiles()
  const {
    response: { data: connData },
  } = useConnectionData()
  const connections = connData.activeConnections

  const graph = useMemo(() => buildFlow(connections), [connections])
  const totals = useMemo(
    () =>
      connections.reduce(
        (sum, conn) => ({
          up: sum.up + (conn.curUpload ?? 0),
          down: sum.down + (conn.curDownload ?? 0),
        }),
        { up: 0, down: 0 },
      ),
    [connections],
  )

  const tunOn = !!verge?.enable_tun_mode && isTunModeAvailable
  const mode = clashConfig?.mode?.toLowerCase() ?? 'rule'

  return (
    <Box
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
        p: 1.5,
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          flexWrap: 'wrap',
        }}
      >
        <Chip
          size="small"
          color={tunOn ? 'success' : 'default'}
          label={tunOn ? t('home.flow.tunOn') : t('home.flow.tunOff')}
        />
        <Chip
          size="small"
          variant="outlined"
          label={
            mode === 'global'
              ? t('home.flow.modes.global')
              : mode === 'direct'
                ? t('home.flow.modes.direct')
                : t('home.flow.modes.rule')
          }
        />
        {current?.name && (
          <Chip size="small" variant="outlined" label={current.name} />
        )}
        <Box sx={{ flex: 1 }} />
        <Typography
          sx={{
            fontSize: 13,
            color: 'text.secondary',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {t('home.flow.connections', { count: connections.length })}
          {'  ·  '}↓ {formatSpeed(totals.down)}
          {'  ·  '}↑ {formatSpeed(totals.up)}
        </Typography>
      </Box>

      {connections.length ? (
        <FlowGraph graph={graph} />
      ) : (
        <Box
          sx={{
            flex: 1,
            display: 'grid',
            placeItems: 'center',
            color: 'text.secondary',
            textAlign: 'center',
          }}
        >
          <Box>
            <AltRouteRounded sx={{ fontSize: 44, opacity: 0.4 }} />
            <Typography sx={{ fontWeight: 600, mt: 1 }}>
              {t('home.flow.emptyTitle')}
            </Typography>
            <Typography sx={{ fontSize: 13, mt: 0.5 }}>
              {t('home.flow.emptyDesc')}
            </Typography>
          </Box>
        </Box>
      )}
    </Box>
  )
}

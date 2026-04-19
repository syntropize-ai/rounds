import corsLib from 'cors'
import type { CorsOptions } from 'cors'
import { createLogger } from '@agentic-obs/common/logging'

const log = createLogger('cors')

const isProd = process.env['NODE_ENV'] === 'production'
const rawOrigins = process.env['CORS_ORIGINS']

let corsOrigin: CorsOptions['origin']
let credentials: boolean

if (isProd) {
  // Production: require explicit CORS_ORIGINS, reject wildcard
  const origins = (rawOrigins ?? '').split(',').map((o) => o.trim()).filter(Boolean)
  if (origins.length === 0 || origins.includes('*')) {
    throw new Error(
      '[cors] FATAL: CORS_ORIGINS must not be "*" or empty in production. ' +
      'Set CORS_ORIGINS to a comma-separated list of allowed origins.',
    )
  }
  corsOrigin = origins
  credentials = true
} else if (rawOrigins) {
  // Non-production with explicit CORS_ORIGINS
  const origins = rawOrigins.split(',').map((o) => o.trim()).filter(Boolean)
  if (origins.includes('*')) {
    log.warn('CORS is open to all origins ("*"). Restrict CORS_ORIGINS before deploying to production.')
    corsOrigin = true
    credentials = false
  } else {
    corsOrigin = origins
    credentials = true
  }
} else {
  // Non-production default: reflect the request origin so dev setups
  // (localhost, 127.0.0.1, LAN IP, any port) work without friction.
  corsOrigin = true
  credentials = true
}

const corsOptions: CorsOptions = {
  origin: corsOrigin,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'Accept'],
  credentials,
}

export const cors = corsLib(corsOptions)

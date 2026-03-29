import jwt from 'jsonwebtoken'
import { createLogger } from '@agentic-obs/common'
import { roleStore } from './rbac.js'

const log = createLogger('auth')
const isProd = process.env['NODE_ENV'] === 'production'
if (isProd && !process.env['JWT_SECRET']) {
  throw new Error('[auth] FATAL: JWT_SECRET environment variable is required in production. ' +
    'Set a cryptographically random secret of at least 32 characters.')
}
if (isProd && !process.env['API_KEYS']) {
  throw new Error('[auth] FATAL: API_KEYS environment variable is required in production. ' +
    'Set a comma-separated list of valid API keys.')
}

const JWT_SECRET = process.env['JWT_SECRET'] ?? 'dev-secret-change-in-prod'
if (!isProd && !process.env['JWT_SECRET']) {
  log.warn('JWT_SECRET not set - using insecure dev default. Do NOT use in production.')
}

const VALID_API_KEYS = new Set((process.env['API_KEYS'] ?? 'test-api-key').split(',').map((k) => k.trim()).filter(Boolean))

function resolveRoleInfo(req, jwtPayload) {
  let roles
  if (jwtPayload) {
    // JWT: read `roles` (array) or `role` (string) from token payload;
    // fall back to `viewer` so JWTs without explicit roles get read-only access.
    const payloadRoles = jwtPayload['roles']
    const payloadRole = jwtPayload['role']
    if (Array.isArray(payloadRoles) && payloadRoles.length > 0) {
      roles = payloadRoles.map(String)
    }
    else if (typeof payloadRole === 'string' && payloadRole.length > 0) {
      roles = [payloadRole]
    }
    else {
      // Allow x-user-role header as a dev-time override (non-production only)
      const isDevEnv = process.env['NODE_ENV'] !== 'production'
      const headerRole = isDevEnv ? req.headers['x-user-role'] : undefined
      roles = [typeof headerRole === 'string' && headerRole.length > 0 ? headerRole : 'viewer']
    }
  }
  else {
    // API key: default to `operator` (service-to-service calls)
    // x-user-role override only permitted outside production
    const isDevEnv = process.env['NODE_ENV'] !== 'production'
    const headerRole = isDevEnv ? req.headers['x-user-role'] : undefined
    roles = [typeof headerRole === 'string' && headerRole.length > 0 ? headerRole : 'operator']
  }
  const permissions = roleStore.resolvePermissions(roles)
  return { roles, permissions }
}

export function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization']
  const apiKey = req.headers['x-api-key']

  // API Key auth
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    if (VALID_API_KEYS.has(apiKey)) {
      const { roles, permissions } = resolveRoleInfo(req)
      req.auth = { sub: apiKey, type: 'apikey', roles, permissions }
      next()
      return
    }
    const error = { code: 'INVALID_API_KEY', message: 'Invalid API key' }
    res.status(401).json(error)
    return
  }

  // JWT auth
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    try {
      const payload = jwt.verify(token, JWT_SECRET)
      const { roles, permissions } = resolveRoleInfo(req, payload)
      req.auth = { sub: payload['sub'] ?? '', type: 'jwt', roles, permissions }
      next()
      return
    }
    catch {
      const error = { code: 'INVALID_TOKEN', message: 'Invalid or expired token' }
      res.status(401).json(error)
      return
    }
  }

  const error = { code: 'UNAUTHORIZED', message: 'Authentication required' }
  res.status(401).json(error)
}

export { requirePermission } from './rbac.js'
//# sourceMappingURL=auth.js.map

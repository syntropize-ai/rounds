import crypto from 'crypto'

export class UserStore {
  users = new Map()
  emailIndex = new Map() // lowercase email -> userId
  externalIndex = new Map() // provider:externalId -> userId
  teams = new Map()
  auditLog = []

  // Users
  create(data) {
    const user = {
      ...data,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
    }
    this.users.set(user.id, user)
    this.emailIndex.set(user.email.toLowerCase(), user.id)
    if (user.externalId) {
      this.externalIndex.set(`${user.authProvider}:${user.externalId}`, user.id)
    }
    return user
  }

  findById(id) {
    return this.users.get(id)
  }

  findByEmail(email) {
    const id = this.emailIndex.get(email.toLowerCase())
    return id ? this.users.get(id) : undefined
  }

  findByExternalId(provider, externalId) {
    const id = this.externalIndex.get(`${provider}:${externalId}`)
    return id ? this.users.get(id) : undefined
  }

  update(id, data) {
    const user = this.users.get(id)
    if (!user)
      return undefined
    if (data.email && data.email !== user.email) {
      this.emailIndex.delete(user.email.toLowerCase())
      this.emailIndex.set(data.email.toLowerCase(), id)
    }
    if (data.externalId && data.externalId !== user.externalId) {
      if (user.externalId) {
        this.externalIndex.delete(`${user.authProvider}:${user.externalId}`)
      }
      this.externalIndex.set(`${data.authProvider || user.authProvider}:${data.externalId}`, id)
    }
    const updated = { ...user, ...data }
    this.users.set(id, updated)
    return updated
  }

  updateLastLogin(id) {
    const user = this.users.get(id)
    if (user) {
      this.users.set(id, { ...user, lastLoginAt: new Date().toISOString() })
    }
  }

  delete(id) {
    const user = this.users.get(id)
    if (!user)
      return false
    this.emailIndex.delete(user.email.toLowerCase())
    if (user.externalId) {
      this.externalIndex.delete(`${user.authProvider}:${user.externalId}`)
    }
    this.users.delete(id)
    return true
  }

  list() {
    return [...this.users.values()]
  }

  count() {
    return this.users.size
  }

  // Teams
  createTeam(data) {
    const team = {
      ...data,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    }
    this.teams.set(team.id, team)
    return team
  }

  findTeamById(id) {
    return this.teams.get(id)
  }

  updateTeam(id, data) {
    const team = this.teams.get(id)
    if (!team)
      return undefined
    const updated = { ...team, ...data }
    this.teams.set(id, updated)
    return updated
  }

  deleteTeam(id) {
    return this.teams.delete(id)
  }

  listTeams() {
    return [...this.teams.values()]
  }

  // Audit Log
  addAuditEntry(entry) {
    this.auditLog.push({
      ...entry,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    })
    // Keep the last 10,000 entries
    if (this.auditLog.length > 10_000) {
      this.auditLog.splice(0, this.auditLog.length - 10_000)
    }
  }

  getAuditLog(limit = 100, offset = 0) {
    const total = this.auditLog.length
    const entries = [...this.auditLog].reverse().slice(offset, offset + limit)
    return { entries, total }
  }
}

export const userStore = new UserStore()
//# sourceMappingURL=user-store.js.map

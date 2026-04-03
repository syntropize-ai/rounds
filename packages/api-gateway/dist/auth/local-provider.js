import { scrypt, randomBytes, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { userStore } from './user-store.js';
const scryptAsync = promisify(scrypt);
const SCRYPT_KEYLEN = 64;
// Default scrypt params: N=16384, r=8, p=1 (matches Node.js defaults)
export async function hashPassword(password) {
    const salt = randomBytes(16).toString('hex');
    const hash = (await scryptAsync(password, salt, SCRYPT_KEYLEN));
    return `${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
    const colonIdx = stored.indexOf(':');
    if (colonIdx < 0)
        return false;
    const salt = stored.slice(0, colonIdx);
    const hashHex = stored.slice(colonIdx + 1);
    try {
        const derived = (await scryptAsync(password, salt, SCRYPT_KEYLEN));
        const storedBuf = Buffer.from(hashHex, 'hex');
        if (derived.length !== storedBuf.length)
            return false;
        return timingSafeEqual(derived, storedBuf);
    }
    catch {
        return false;
    }
}
export async function localLogin(email, password) {
    const user = userStore.findByEmail(email);
    if (!user || user.authProvider !== 'local' || user.disabled)
        return null;
    if (!user.passwordHash)
        return null;
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid)
        return null;
    userStore.updateLastLogin(user.id);
    return user;
}
export async function createLocalUser(email, password, name, role = 'viewer') {
    const existing = userStore.findByEmail(email);
    if (existing)
        throw new Error(`User with email ${email} already exists`);
    const passwordHash = await hashPassword(password);
    return userStore.create({ email, name, authProvider: 'local', role, teams: [], passwordHash });
}
//# sourceMappingURL=local-provider.js.map
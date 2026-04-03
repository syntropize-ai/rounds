// JSON file persistence for all in-memory stores
// Like Grafana's default SQLite - zero-config, data survives restarts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const DATA_DIR = process.env['DATA_DIR'] || join(process.cwd(), '.uname-data');
const STORE_FILE = join(DATA_DIR, 'stores.json');
const registry = new Map();
let flushTimer = null;
let dirty = false;
export function registerStore(name, store) {
    registry.set(name, store);
}
export async function loadAll() {
    try {
        const raw = await readFile(STORE_FILE, 'utf-8');
        const data = JSON.parse(raw);
        for (const [name, store] of registry) {
            if (data[name] !== undefined) {
                try {
                    store.loadJSON(data[name]);
                }
                catch (err) {
                    console.error(`[persistence] Failed to load store "${name}":`, err);
                }
            }
        }
        console.log(`[persistence] Loaded ${registry.size} stores from ${STORE_FILE}`);
    }
    catch (err) {
        if (err.code === 'ENOENT') {
            console.log('[persistence] No saved data found - starting fresh');
        }
        else {
            console.error('[persistence] Failed to read store file:', err);
        }
    }
}
async function flush() {
    if (!dirty)
        return;
    dirty = false;
    const snapshot = {};
    for (const [name, store] of registry)
        snapshot[name] = store.toJSON();
    try {
        await mkdir(DATA_DIR, { recursive: true });
        // Write to temp file first, then rename for atomicity
        const tmpFile = `${STORE_FILE}.tmp`;
        await writeFile(tmpFile, JSON.stringify(snapshot, null, 2), 'utf-8');
        await (await import('node:fs/promises')).rename(tmpFile, STORE_FILE);
    }
    catch (err) {
        console.error('[persistence] Failed to write store file:', err);
    }
}
export function markDirty() {
    dirty = true;
    if (flushTimer)
        return;
    // Debounce: write at most every 2 seconds
    flushTimer = setTimeout(() => {
        flushTimer = null;
        void flush();
    }, 2000);
}
export async function flushStores() {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    dirty = true; // Force final flush
    await flush();
    console.log('[persistence] Final flush complete');
}
//# sourceMappingURL=persistence.js.map
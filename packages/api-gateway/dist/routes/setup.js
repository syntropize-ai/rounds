import { Router } from 'express';
import promises as fs from 'fs';
import { execSync } from 'child_process';
import homedir from 'os';
import { join } from 'path';
const CONFIG_DIR = join(homedir.homedir(), '.agentic-obs');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
let inMemoryConfig = {
    configured: false,
    datasources: [],
};
async function loadConfig() {
    try {
        const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return inMemoryConfig;
    }
}
async function saveConfig(config) {
    inMemoryConfig = config;
    try {
        await fs.mkdir(CONFIG_DIR, { recursive: true });
        await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    }
    catch {
    }
}
function resolveToken(cfg) {
    if (cfg.tokenHelperCommand) {
        try {
            return execSync(cfg.tokenHelperCommand, { timeout: 10_000, encoding: 'utf-8' }).trim();
        }
        catch {
            return null;
        }
    }
    return cfg.apiKey ?? null;
}
async function testLlmConnection(cfg) {
    try {
        if (cfg.provider === 'corporate-gateway') {
            const token = resolveToken(cfg);
            if (!token) {
                return { ok: false, message: cfg.tokenHelperCommand ? 'Token helper command failed' : 'API key is required' };
            }
            const baseUrl = cfg.baseUrl;
            if (!baseUrl) {
                return { ok: false, message: 'Gateway base URL is required' };
            }
            const authType = cfg.authType ?? 'bearer';
            const res = await fetch(`${baseUrl}/v2/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(authType === 'bearer' ? { 'Authorization': `Bearer ${token}` } : { 'X-api-key': token }),
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model: cfg.model || 'claude-sonnet-4-5',
                    messages: [{ role: 'user', content: 'Say "ok"' }],
                    max_tokens: 5,
                }),
                signal: AbortSignal.timeout(15_000),
            });
            if (res.ok) {
                return { ok: true, message: 'Connected via corporate gateway' };
            }
            const body = await res.json().catch(() => ({}));
            return { ok: false, message: body.error?.message ?? `HTTP ${res.status}` };
        }
        if (cfg.provider === 'anthropic') {
            const key = cfg.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
            if (!key) {
                return { ok: false, message: 'API key is required' };
            }
            const baseUrl = cfg.baseUrl || 'https://api.anthropic.com';
            const res = await fetch(`${baseUrl}/v1/models`, {
                headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
            });
            if (res.ok) {
                return { ok: true, message: 'Connected successfully' };
            }
            const body = await res.json().catch(() => ({}));
            return { ok: false, message: body.error?.message ?? `HTTP ${res.status}` };
        }
        if (cfg.provider === 'openai') {
            const key = cfg.apiKey ?? process.env.OPENAI_API_KEY ?? '';
            if (!key) {
                return { ok: false, message: 'API key is required' };
            }
            const res = await fetch('https://api.openai.com/v1/models', {
                headers: { Authorization: `Bearer ${key}` },
            });
            if (res.ok) {
                return { ok: true, message: 'Connected successfully' };
            }
            const body = await res.json().catch(() => ({}));
            return { ok: false, message: body.error?.message ?? `HTTP ${res.status}` };
        }
        if (cfg.provider === 'azure-openai') {
            if (!cfg.apiKey || !cfg.baseUrl) {
                return { ok: false, message: 'API key and endpoint URL are required' };
            }
            return { ok: true, message: 'Configuration looks valid (live test not performed)' };
        }
        if (cfg.provider === 'aws-bedrock') {
            if (!cfg.region) {
                return { ok: false, message: 'AWS region is required' };
            }
            return { ok: true, message: 'Configuration looks valid (live test not performed)' };
        }
        return { ok: false, message: 'Unknown provider' };
    }
    catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : 'Connection failed' };
    }
}
async function testDatasourceConnection(ds) {
    try {
        const headers = {};
        if (ds.apiKey) {
            headers['Authorization'] = `Bearer ${ds.apiKey}`;
        }
        else if (ds.username && ds.password) {
            headers['Authorization'] = `Basic ${Buffer.from(`${ds.username}:${ds.password}`).toString('base64')}`;
        }
        let testUrl = ds.url;
        if (ds.type === 'loki') {
            testUrl = `${ds.url}/ready`;
        }
        else if (ds.type === 'elasticsearch') {
            testUrl = `${ds.url}/_cluster/health`;
        }
        else if (ds.type === 'prometheus') {
            testUrl = `${ds.url}/-/healthy`;
        }
        else if (ds.type === 'tempo') {
            testUrl = `${ds.url}/ready`;
        }
        else if (ds.type === 'jaeger') {
            testUrl = `${ds.url}/api/services`;
        }
        const res = await fetch(testUrl, { headers, signal: AbortSignal.timeout(5_000) });
        if (res.ok) {
            return { ok: true, message: 'Connected successfully' };
        }
        return { ok: false, message: `HTTP ${res.status}` };
    }
    catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : 'Connection failed' };
    }
}
export function getSetupConfig() {
    return inMemoryConfig;
}
export async function updateDatasources(datasources) {
    inMemoryConfig = { ...inMemoryConfig, datasources };
    await saveConfig(inMemoryConfig);
}
let configLoadPromise;
export async function ensureConfigLoaded() {
    if (!configLoadPromise) {
        configLoadPromise = loadConfig().then(cfg => { inMemoryConfig = cfg; });
    }
    return configLoadPromise;
}
export function createSetupRouter() {
    const router = Router();
    void ensureConfigLoaded();
    router.get('/status', (_req, res) => {
        res.json({
            configured: inMemoryConfig.configured,
            hasLlm: !!inMemoryConfig.llm,
            datasourcesCount: inMemoryConfig.datasources.length,
            notificationChannels: !!inMemoryConfig.notifications?.slack || !!inMemoryConfig.notifications?.pagerduty,
            completedAt: inMemoryConfig.completedAt,
        });
    });
    router.post('/llm', async (req, res) => {
        const cfg = req.body;
        if (!cfg.provider || !cfg.model) {
            res.status(400).json({ error: { code: 'VALIDATION', message: 'provider and model are required' } });
            return;
        }
        if (cfg.test) {
            const result = await testLlmConnection(cfg);
            if (!result.ok) {
                res.status(400).json({ error: { code: 'CONNECTION_FAILED', message: result.message } });
                return;
            }
            res.json({ ok: true, message: result.message });
            return;
        }
        inMemoryConfig = { ...inMemoryConfig, llm: cfg };
        await saveConfig(inMemoryConfig);
        res.json({ ok: true });
    });
    router.post('/llm/test', async (req, res) => {
        const cfg = req.body;
        const result = await testLlmConnection(cfg);
        res.status(result.ok ? 200 : 400).json(result);
    });
    router.post('/datasource', async (req, res) => {
        const body = req.body;
        const ds = body.datasource;
        if (!ds?.type || !ds.url) {
            res.status(400).json({ error: { code: 'VALIDATION', message: 'type and url are required' } });
            return;
        }
        if (body.test) {
            const result = await testDatasourceConnection(ds);
            if (!result.ok) {
                res.status(400).json({ error: { code: 'CONNECTION_FAILED', message: result.message } });
                return;
            }
            res.json({ ok: true, message: result.message });
            return;
        }
        if (ds.id) {
            const dsId = ds.id;
            inMemoryConfig = {
                ...inMemoryConfig,
                datasources: inMemoryConfig.datasources.filter(d => d.id !== dsId),
            };
        }
        else {
            ds.id = `${ds.type}-${Date.now()}`;
        }
        const existing = inMemoryConfig.datasources.findIndex(d => d.id === ds.id);
        if (existing >= 0) {
            inMemoryConfig.datasources[existing] = ds;
        }
        else {
            inMemoryConfig.datasources.push(ds);
        }
        await saveConfig(inMemoryConfig);
        res.json({ ok: true, datasource: ds });
    });
    router.delete('/datasource/:id', async (req, res) => {
        const id = req.params['id'];
        inMemoryConfig = {
            ...inMemoryConfig,
            datasources: inMemoryConfig.datasources.filter(d => d.id !== id),
        };
        await saveConfig(inMemoryConfig);
        res.json({ ok: true });
    });
    router.post('/notifications', async (req, res) => {
        const body = req.body;
        inMemoryConfig = { ...inMemoryConfig, notifications: body };
        await saveConfig(inMemoryConfig);
        res.json({ ok: true });
    });
    router.post('/complete', async (_req, res) => {
        inMemoryConfig = {
            ...inMemoryConfig,
            configured: true,
            completedAt: new Date().toISOString(),
        };
        await saveConfig(inMemoryConfig);
        res.json({ ok: true, completedAt: inMemoryConfig.completedAt });
    });
    router.post('/reset', async (_req, res) => {
        inMemoryConfig = {
            configured: false,
            datasources: [],
        };
        await saveConfig(inMemoryConfig);
        res.json({ ok: true });
    });
    return router;
}
//# sourceMappingURL=setup.js.map

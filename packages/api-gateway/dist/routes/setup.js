import { Router } from 'express';
import { promises as fs } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { createLogger, DEFAULT_LLM_MODEL } from '@agentic-obs/common';
const log = createLogger('setup');
import { AnthropicProvider, OpenAIProvider, GeminiProvider, OllamaProvider, } from '@agentic-obs/llm-gateway';
// -- Persistence
const CONFIG_DIR = join(homedir(), '.agentic-obs');
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
    catch (err) {
        log.debug({ err }, 'failed to load config file, using in-memory config');
        return inMemoryConfig;
    }
}
async function saveConfig(config) {
    inMemoryConfig = config;
    try {
        await fs.mkdir(CONFIG_DIR, { recursive: true });
        await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    }
    catch (err) {
        log.debug({ err }, 'failed to persist config file (best-effort)');
    }
}
// -- LLM Connectivity Test
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
        // Corporate gateway: use token helper + bearer auth + custom base URL
        if (cfg.provider === 'corporate-gateway' || cfg.tokenHelperCommand) {
            const token = resolveToken(cfg);
            if (!token)
                return { ok: false, message: cfg.tokenHelperCommand ? 'Token helper command failed' : 'API key is required' };
            const baseUrl = cfg.baseUrl;
            if (!baseUrl)
                return { ok: false, message: 'Gateway base URL is required' };
            // Test with a minimal API call
            const res = await fetch(`${baseUrl}/v1/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(cfg.authType === 'bearer'
                        ? { Authorization: `Bearer ${token}` }
                        : { 'api-key': token }),
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model: cfg.model || DEFAULT_LLM_MODEL,
                    messages: [{ role: 'user', content: 'Say "ok".' }],
                    max_tokens: 5,
                }),
                signal: AbortSignal.timeout(15_000),
            });
            if (res.ok)
                return { ok: true, message: 'Connected via corporate gateway' };
            const body = await res.json().catch(() => ({}));
            return { ok: false, message: body.error?.message ?? `HTTP ${res.status}` };
        }
        if (cfg.provider === 'anthropic') {
            const key = cfg.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
            if (!key)
                return { ok: false, message: 'API key is required' };
            const baseUrl = cfg.baseUrl || 'https://api.anthropic.com';
            const res = await fetch(`${baseUrl}/v1/models`, {
                headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
            });
            if (res.ok)
                return { ok: true, message: 'Connected successfully' };
            const body = await res.json().catch(() => ({}));
            return { ok: false, message: body.error?.message ?? `HTTP ${res.status}` };
        }
        if (cfg.provider === 'openai' || cfg.provider === 'deepseek') {
            const key = cfg.apiKey ?? '';
            if (!key)
                return { ok: false, message: 'API key is required' };
            const base = cfg.provider === 'deepseek'
                ? (cfg.baseUrl || 'https://api.deepseek.com')
                : (cfg.baseUrl || 'https://api.openai.com/v1');
            const res = await fetch(`${base}/models`, {
                headers: { Authorization: `Bearer ${key}` },
            });
            if (res.ok)
                return { ok: true, message: 'Connected successfully' };
            const body = await res.json().catch(() => ({}));
            return { ok: false, message: body.error?.message ?? `HTTP ${res.status}` };
        }
        if (cfg.provider === 'ollama') {
            const base = cfg.baseUrl || 'http://localhost:11434';
            const res = await fetch(`${base}/api/tags`);
            if (res.ok)
                return { ok: true, message: 'Connected successfully' };
            return { ok: false, message: `HTTP ${res.status}` };
        }
        if (cfg.provider === 'gemini') {
            const key = cfg.apiKey ?? process.env['GEMINI_API_KEY'] ?? '';
            if (!key)
                return { ok: false, message: 'API key is required' };
            const base = cfg.baseUrl || 'https://generativelanguage.googleapis.com';
            const res = await fetch(`${base}/v1beta/models?key=${key}`);
            if (res.ok)
                return { ok: true, message: 'Connected successfully' };
            const body = await res.json().catch(() => ({}));
            return { ok: false, message: body.error?.message ?? `HTTP ${res.status}` };
        }
        if (cfg.provider === 'azure-openai') {
            if (!cfg.apiKey || !cfg.baseUrl)
                return { ok: false, message: 'API key and endpoint URL are required' };
            return { ok: true, message: 'Configuration looks valid (live test not performed)' };
        }
        if (cfg.provider === 'aws-bedrock') {
            if (!cfg.region)
                return { ok: false, message: 'AWS region is required' };
            return { ok: true, message: 'Configuration looks valid (live test not performed)' };
        }
        return { ok: false, message: 'Unknown provider' };
    }
    catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : 'Connection failed' };
    }
}
// -- Datasource Connectivity Test
import { testDatasourceConnection } from '../utils/datasource.js';
// -- Model Listing
async function fetchModels(cfg) {
    try {
        switch (cfg.provider) {
            case 'anthropic': {
                const provider = new AnthropicProvider({ apiKey: cfg.apiKey ?? '', baseUrl: cfg.baseUrl });
                return await provider.listModels();
            }
            case 'openai':
            case 'deepseek': {
                const base = cfg.provider === 'deepseek'
                    ? (cfg.baseUrl || 'https://api.deepseek.com')
                    : cfg.baseUrl;
                const provider = new OpenAIProvider({ apiKey: cfg.apiKey ?? '', baseUrl: base });
                return await provider.listModels();
            }
            case 'gemini': {
                const provider = new GeminiProvider({ apiKey: cfg.apiKey ?? '', baseUrl: cfg.baseUrl });
                return await provider.listModels();
            }
            case 'ollama': {
                const provider = new OllamaProvider({ baseUrl: cfg.baseUrl });
                return await provider.listModels();
            }
            default:
                return [];
        }
    }
    catch {
        return [];
    }
}
// -- Public access
/** Returns the current in-memory setup config (LLM, datasources, etc.). */
export function getSetupConfig() {
    return inMemoryConfig;
}
/** Updates only the datasources array in the current config and persists. */
export async function updateDatasources(datasources) {
    inMemoryConfig = { ...inMemoryConfig, datasources };
    await saveConfig(inMemoryConfig);
}
/** Ensures persisted config is loaded into memory. Safe to call multiple times. */
let configLoadPromise;
export function ensureConfigLoaded() {
    if (!configLoadPromise) {
        configLoadPromise = loadConfig().then((cfg) => {
            inMemoryConfig = cfg;
        });
    }
    return configLoadPromise;
}
// -- Router
export function createSetupRouter() {
    const router = Router();
    // Load persisted config on startup
    void ensureConfigLoaded().catch((err) => {
        log.error({ err }, 'failed to load config');
    });
    // GET /api/setup/config — returns current config (API keys masked)
    router.get('/config', (_req, res) => {
        const cfg = { ...inMemoryConfig };
        // Mask sensitive fields
        if (cfg.llm) {
            cfg.llm = {
                ...cfg.llm,
                apiKey: cfg.llm.apiKey ? '••••••' + cfg.llm.apiKey.slice(-4) : undefined,
                tokenHelperCommand: cfg.llm.tokenHelperCommand,
            };
        }
        cfg.datasources = cfg.datasources.map((ds) => ({
            ...ds,
            apiKey: ds.apiKey ? '••••••' + ds.apiKey.slice(-4) : undefined,
            password: ds.password ? '••••••' : undefined,
        }));
        res.json(cfg);
    });
    // GET /api/setup/status
    router.get('/status', (_req, res) => {
        res.json({
            configured: inMemoryConfig.configured,
            hasLLM: !!inMemoryConfig.llm,
            datasourceCount: inMemoryConfig.datasources.length,
            hasNotifications: !!(inMemoryConfig.notifications?.slack
                || inMemoryConfig.notifications?.pagerduty
                || inMemoryConfig.notifications?.email),
        });
    });
    // POST /api/setup/llm
    router.post('/llm', async (req, res) => {
        const body = req.body;
        const cfg = body.config;
        if (!cfg?.provider || !cfg?.model) {
            res.status(400).json({ error: { code: 'VALIDATION', message: 'provider and model are required' } });
            return;
        }
        if (body.test) {
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
    // POST /api/setup/llm/test
    router.post('/llm/test', async (req, res) => {
        const cfg = req.body;
        const result = await testLlmConnection(cfg);
        res.status(result.ok ? 200 : 400).json(result);
    });
    // POST /api/setup/llm/models — fetch available models from provider
    router.post('/llm/models', async (req, res) => {
        const cfg = req.body;
        if (!cfg?.provider) {
            res.status(400).json({ error: { code: 'VALIDATION', message: 'provider is required' } });
            return;
        }
        const models = await fetchModels(cfg);
        res.json({ models });
    });
    // POST /api/setup/datasource
    router.post('/datasource', async (req, res) => {
        const body = req.body;
        const ds = body.datasource;
        if (!ds?.type || !ds?.url) {
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
        const existing = inMemoryConfig.datasources.findIndex((d) => d.id === ds.id);
        const datasources = [...inMemoryConfig.datasources];
        if (existing >= 0)
            datasources[existing] = ds;
        else
            datasources.push(ds);
        inMemoryConfig = { ...inMemoryConfig, datasources };
        await saveConfig(inMemoryConfig);
        res.json({ ok: true, datasource: ds });
    });
    // DELETE /api/setup/datasource/:id
    router.delete('/datasource/:id', async (req, res) => {
        const id = req.params['id'] ?? '';
        inMemoryConfig = {
            ...inMemoryConfig,
            datasources: inMemoryConfig.datasources.filter((d) => d.id !== id),
        };
        await saveConfig(inMemoryConfig);
        res.json({ ok: true });
    });
    // POST /api/setup/notifications
    router.post('/notifications', async (req, res) => {
        const notifications = req.body;
        inMemoryConfig = { ...inMemoryConfig, notifications };
        await saveConfig(inMemoryConfig);
        res.json({ ok: true });
    });
    // POST /api/setup/complete
    router.post('/complete', async (_req, res) => {
        inMemoryConfig = {
            ...inMemoryConfig,
            configured: true,
            completedAt: new Date().toISOString(),
        };
        await saveConfig(inMemoryConfig);
        res.json({ ok: true, completedAt: inMemoryConfig.completedAt });
    });
    // POST /api/setup/reset (dev utility)
    router.post('/reset', async (_req, res) => {
        inMemoryConfig = { configured: false, datasources: [] };
        await saveConfig(inMemoryConfig);
        res.json({ ok: true });
    });
    return router;
}
//# sourceMappingURL=setup.js.map
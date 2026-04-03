import { Router } from 'express';
import { authManager } from '../auth/auth-manager.js';
import { userStore } from '../auth/user-store.js';
import { authMiddleware } from '../middleware/auth.js';
/** Strip sensitive fields before sending a User object to the client */
function sanitizeUser(user) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash, ...safe } = user;
    return safe;
}
export function createAuthRouter() {
    const router = Router();
    // GET /api/auth/providers - list enabled auth methods (for login page buttons)
    router.get('/providers', (_req, res) => {
        res.json({ providers: authManager.getEnabledProviders() });
    });
    // -- OIDC
    // GET /api/auth/login/oidc - 302 to IdP
    router.get('/login/oidc', async (_req, res) => {
        try {
            const { url } = await authManager.getOidcAuthUrl();
            res.redirect(url);
        }
        catch (err) {
            res.status(400).json({
                code: 'OIDC_NOT_CONFIGURED',
                message: err instanceof Error ? err.message : 'OIDC error',
            });
        }
    });
    // GET /api/auth/callback/oidc - OIDC redirect callback
    router.get('/callback/oidc', async (req, res) => {
        const { error, code, state } = req.query;
        if (error) {
            res.redirect(`/login?error=${encodeURIComponent(error)}`);
            return;
        }
        if (!code || !state) {
            res.redirect('/login?error=missing_params');
            return;
        }
        try {
            const meta = { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
            const result = await authManager.handleOidcCallback(code, state, meta);
            res.redirect(`/login/callback?token=${encodeURIComponent(result.tokens.accessToken)}&refresh=${encodeURIComponent(result.tokens.refreshToken)}`);
        }
        catch (err) {
            res.redirect(`/login?error=${encodeURIComponent(err instanceof Error ? err.message : 'auth_failed')}`);
        }
    });
    // -- GitHub OAuth
    router.get('/login/github', (_req, res) => {
        try {
            const { url } = authManager.getOAuthAuthUrl('github');
            res.redirect(url);
        }
        catch (err) {
            res.status(400).json({
                code: 'GITHUB_NOT_CONFIGURED',
                message: err instanceof Error ? err.message : 'Github OAuth error',
            });
        }
    });
    router.get('/callback/github', async (req, res) => {
        const { code, state, error } = req.query;
        if (error || !code || !state) {
            res.redirect(`/login?error=${encodeURIComponent(error ?? 'missing_params')}`);
            return;
        }
        try {
            const meta = { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
            const result = await authManager.handleOAuthCallback('github', code, state, meta);
            res.redirect(`/login/callback?token=${encodeURIComponent(result.tokens.accessToken)}&refresh=${encodeURIComponent(result.tokens.refreshToken)}`);
        }
        catch (err) {
            res.redirect(`/login?error=${encodeURIComponent(err instanceof Error ? err.message : 'auth_failed')}`);
        }
    });
    // -- Google OAuth
    router.get('/login/google', (_req, res) => {
        try {
            const { url } = authManager.getOAuthAuthUrl('google');
            res.redirect(url);
        }
        catch (err) {
            res.status(400).json({
                code: 'GOOGLE_NOT_CONFIGURED',
                message: err instanceof Error ? err.message : 'Google OAuth error',
            });
        }
    });
    router.get('/callback/google', async (req, res) => {
        const { code, state, error } = req.query;
        if (error || !code || !state) {
            res.redirect(`/login?error=${encodeURIComponent(error ?? 'missing_params')}`);
            return;
        }
        try {
            const meta = { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
            const result = await authManager.handleOAuthCallback('google', code, state, meta);
            res.redirect(`/login/callback?token=${encodeURIComponent(result.tokens.accessToken)}&refresh=${encodeURIComponent(result.tokens.refreshToken)}`);
        }
        catch (err) {
            res.redirect(`/login?error=${encodeURIComponent(err instanceof Error ? err.message : 'auth_failed')}`);
        }
    });
    // -- Local auth
    router.post('/login/local', async (req, res) => {
        const { email, password } = req.body;
        if (!email || !password) {
            res.status(400).json({ code: 'VALIDATION', message: 'email and password are required' });
            return;
        }
        const meta = { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
        const result = await authManager.localLogin(email, password, meta);
        if (!result) {
            res.status(401).json({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
            return;
        }
        res.json({ user: sanitizeUser(result.user), tokens: result.tokens });
    });
    // POST /api/auth/logout
    router.post('/logout', authMiddleware, (req, res) => {
        if (req.auth?.sub)
            authManager.logout(req.auth.sub);
        res.json({ ok: true });
    });
    // GET /api/auth/me
    router.get('/me', authMiddleware, (req, res) => {
        if (!req.auth?.sub) {
            res.status(401).json({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
            return;
        }
        const user = userStore.findById(req.auth.sub);
        if (!user) {
            res.status(404).json({ code: 'USER_NOT_FOUND', message: 'User not found' });
            return;
        }
        res.json({
            user: sanitizeUser(user),
            permissions: req.auth.permissions ?? [],
            roles: req.auth.roles ?? [],
        });
    });
    // POST /api/auth/refresh
    router.post('/refresh', (req, res) => {
        const { refreshToken } = req.body;
        if (!refreshToken) {
            res.status(400).json({ code: 'VALIDATION', message: 'refreshToken is required' });
            return;
        }
        const tokens = authManager.refresh?.(refreshToken);
        if (!tokens) {
            res.status(401).json({ code: 'INVALID_REFRESH_TOKEN', message: 'Invalid or expired refresh token' });
            return;
        }
        res.json({ tokens });
    });
    // GET /api/auth/saml/metadata - SP metadata XML for IdP registration
    router.get('/saml/metadata', (_req, res) => {
        res.status(501).json({ code: 'NOT_IMPLEMENTED', message: 'SAML not configured' });
    });
    return router;
}
//# sourceMappingURL=auth.js.map
import crypto from 'crypto';
const oauthStates = new Map();
function purgeExpiredStates() {
    for (const [k, v] of oauthStates) {
        if (Date.now() - v.createdAt > 10 * 60 * 1000)
            oauthStates.delete(k);
    }
}
const ENDPOINTS = {
    github: {
        auth: 'https://github.com/login/oauth/authorize',
        token: 'https://github.com/login/oauth/access_token',
        userInfo: 'https://api.github.com/user',
        userEmails: 'https://api.github.com/user/emails',
    },
    google: {
        auth: 'https://accounts.google.com/o/oauth2/v2/auth',
        token: 'https://oauth2.googleapis.com/token',
        userInfo: 'https://www.googleapis.com/oauth2/v3/userinfo',
    },
};
export class OAuthProvider {
    config;
    constructor(config) {
        this.config = config;
    }
    getAuthorizationUrl() {
        const state = crypto.randomBytes(16).toString('hex');
        purgeExpiredStates();
        oauthStates.set(state, { createdAt: Date.now() });
        const ep = ENDPOINTS[this.config.provider];
        const defaultScopes = this.config.provider === 'github'
            ? ['openid', 'email', 'read:user']
            : ['openid', 'email', 'profile'];
        const scopes = this.config.scopes ?? defaultScopes;
        const params = new URLSearchParams({
            client_id: this.config.clientId,
            redirect_uri: this.config.redirectUri,
            scope: scopes.join(' '),
            state,
            response_type: 'code',
        });
        return { url: `${ep.auth}?${params}`, state };
    }
    async handleCallback(code, state) {
        const saved = oauthStates.get(state);
        if (!saved)
            throw new Error('Invalid or expired OAuth state parameter');
        oauthStates.delete(state);
        const ep = ENDPOINTS[this.config.provider];
        const tokenRes = await fetch(ep.token, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams({
                client_id: this.config.clientId,
                client_secret: this.config.clientSecret,
                code,
                redirect_uri: this.config.redirectUri,
                grant_type: 'authorization_code',
            }),
        });
        if (!tokenRes.ok)
            throw new Error(`OAuth token exchange failed: HTTP ${tokenRes.status}`);
        const tokenData = (await tokenRes.json());
        if (tokenData.error || !tokenData.access_token)
            throw new Error(`OAuth error: ${String(tokenData.error ?? 'no access_token returned')}`);
        const accessToken = tokenData.access_token;
        const userInfoRes = await fetch(ep.userInfo, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/json',
                ...(this.config.provider === 'github' ? { 'User-Agent': 'AgentObs/1.0' } : {}),
            },
        });
        if (!userInfoRes.ok)
            throw new Error('Failed to fetch OAuth user info');
        const userInfo = (await userInfoRes.json());
        return this.config.provider === 'github'
            ? this.normalizeGitHub(userInfo, accessToken)
            : this.normalizeGoogle(userInfo);
    }
    async normalizeGitHub(data, accessToken) {
        let email = data['email'] ?? null;
        // GitHub may omit email in user object - fetch from emails endpoint
        if (!email) {
            const emailRes = await fetch(ENDPOINTS.github.userEmails, {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: 'application/json',
                    'User-Agent': 'AgentObs/1.0',
                },
            });
            if (emailRes.ok) {
                const emails = (await emailRes.json());
                const primary = emails.find((e) => e.primary && e.verified);
                email = primary?.email ?? emails[0]?.email ?? null;
            }
        }
        return {
            sub: `github:${String(data['id'])}`,
            email: email ?? '',
            name: data['name'] || data['login'] || '',
            picture: data['avatar_url'],
        };
    }
    normalizeGoogle(data) {
        return {
            sub: String(data['sub']),
            email: data['email'] ?? '',
            name: data['name'] ?? '',
            picture: data['picture'],
        };
    }
}
//# sourceMappingURL=oauth-provider.js.map
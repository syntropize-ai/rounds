/**
 * GitHub App config repository (one row per org).
 *
 * Created by the App Manifest flow once an operator clicks
 * "Register Rounds GitHub App". The client secret / private key / webhook
 * secret are encrypted at rest via `@agentic-obs/server-utils/crypto`;
 * `get()` returns plaintext PEM + client secret because every consumer
 * (JWT signer, install URL builder, callback handler) needs them in the
 * clear and we don't want ciphertext leaking outside this repo.
 */

export interface GithubAppConfig {
  orgId: string;
  appId: number;
  slug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  webhookSecret: string | null;
  registeredAt: string;
  registeredBy: string;
}

export type NewGithubAppConfig = Omit<GithubAppConfig, 'registeredAt'>;

export interface IGithubAppConfigRepository {
  get(orgId: string): Promise<GithubAppConfig | null>;
  insert(input: NewGithubAppConfig): Promise<GithubAppConfig>;
  delete(orgId: string): Promise<boolean>;
}

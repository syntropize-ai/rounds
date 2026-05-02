/**
 * SSRF guard: with `OPENOBS_ALLOW_PRIVATE_URLS=false`, attempting to
 * register / probe a datasource pointing at a private network address
 * should be refused.
 *
 * Skipped: the e2e harness deploys with the default (relaxed) URL
 * policy because every test datasource lives on the cluster's private
 * network. Re-running this scenario requires a separate harness deploy
 * with the strict env var; documented below.
 */
import { describe, it } from 'vitest';

describe.skip('datasources/ssrf-blocks-private-when-strict', () => {
  it('strict mode: probe to private URL returns ok=false (not exercised in default config)', () => {
    // Recipe (manual):
    //   1. helm upgrade openobs-test ... --set env.OPENOBS_ALLOW_PRIVATE_URLS=false
    //   2. POST /api/datasources/test with type=prometheus, url=http://10.0.0.1:9090
    //   3. assert 400 + ok:false + message references SSRF / private url
  });
});

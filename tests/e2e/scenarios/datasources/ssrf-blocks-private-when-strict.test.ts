/**
 * SSRF guard: blocking private network addresses is the default, so
 * registering / probing a connector pointing at one is refused unless the
 * deployment opts out with `OPENOBS_ALLOW_PRIVATE_URLS=true`.
 *
 * Skipped: the e2e harness pins the opt-out to "true" (see
 * tests/e2e/fixtures/helm/values.test.yaml) because every test connector
 * lives on the cluster's private network. Re-running this scenario requires
 * a separate harness deploy without it; documented below.
 */
import { describe, it } from 'vitest';

describe.skip('connectors/ssrf-blocks-private-when-strict', () => {
  it('strict mode: probe to private URL returns ok=false (not exercised in default config)', () => {
    // Recipe (manual):
    //   1. helm upgrade openobs-test ... --set env.OPENOBS_ALLOW_PRIVATE_URLS=false
    //   2. POST /api/connectors/test with type=prometheus, url=http://10.0.0.1:9090
    //   3. assert 400 + ok:false + message references SSRF / private url
  });
});

import { describe, it, expect } from 'vitest';
import { createResolverRegistry } from './index.js';

describe('resolver registry', () => {
  it('unknown kind returns the scope unchanged', async () => {
    const reg = createResolverRegistry({ orgId: 'org_main' });
    expect(await reg.resolve('unknown:uid:xyz')).toEqual(['unknown:uid:xyz']);
  });

  it('empty / wildcard scope is a pass-through', async () => {
    const reg = createResolverRegistry({ orgId: 'org_main' });
    expect(await reg.resolve('')).toEqual(['']);
    expect(await reg.resolve('*')).toEqual(['*']);
  });

  it('dashboards expands to include wildcard variants', async () => {
    const reg = createResolverRegistry({ orgId: 'org_main' });
    const out = await reg.resolve('dashboards:uid:abc');
    expect(out).toContain('dashboards:uid:abc');
    expect(out).toContain('dashboards:*');
    expect(out).toContain('dashboards:uid:*');
  });

  it('folders without a folder repo returns literal + wildcards', async () => {
    const reg = createResolverRegistry({ orgId: 'org_main' });
    const out = await reg.resolve('folders:uid:f1');
    expect(out).toContain('folders:uid:f1');
    expect(out).toContain('folders:*');
  });

  it('alert.rules resolver adds the folders:* cascade hint', async () => {
    const reg = createResolverRegistry({ orgId: 'org_main' });
    const out = await reg.resolve('alert.rules:uid:abc');
    expect(out).toContain('alert.rules:uid:abc');
    expect(out).toContain('folders:*');
  });

  it('connectors / users / teams / serviceaccounts resolve with wildcards', async () => {
    const reg = createResolverRegistry({ orgId: 'org_main' });
    expect(await reg.resolve('connectors:uid:p')).toContain('connectors:*');
    expect(await reg.resolve('users:id:u1')).toContain('users:*');
    expect(await reg.resolve('teams:id:t1')).toContain('teams:*');
    expect(await reg.resolve('serviceaccounts:id:s1')).toContain(
      'serviceaccounts:*',
    );
  });
});

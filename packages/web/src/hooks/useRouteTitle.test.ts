import { describe, it, expect } from 'vitest';
import { titleForPath } from './useRouteTitle.js';

describe('titleForPath', () => {
  it('titles static routes', () => {
    expect(titleForPath('/')).toBe('Home · Rounds');
    expect(titleForPath('/actions')).toBe('Action Center · Rounds');
    expect(titleForPath('/admin/service-accounts')).toBe('Service Accounts · Rounds');
  });

  it('titles parameterised routes', () => {
    expect(titleForPath('/investigations/inv-123')).toBe('Investigation · Rounds');
    expect(titleForPath('/plans/plan-abc')).toBe('Review Fix · Rounds');
    expect(titleForPath('/alerts/rule-1/edit')).toBe('Edit Alert Rule · Rounds');
  });

  it('ignores a trailing slash', () => {
    expect(titleForPath('/dashboards/')).toBe('Dashboards · Rounds');
  });

  it('falls back to the bare app name for an unrouted path', () => {
    expect(titleForPath('/nope')).toBe('Rounds');
  });
});

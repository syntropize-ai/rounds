/**
 * The screen shown instead of a sign-in form when the backend is not there.
 *
 * Its whole job is to stop someone typing credentials into a page that cannot
 * succeed, so the two things tested are that it says the API is the problem
 * and that it does not read as a login failure.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiUnreachableScreen } from './App.js';

const html = (detail: string) =>
  renderToStaticMarkup(<ApiUnreachableScreen detail={detail} />);

describe('ApiUnreachableScreen', () => {
  const rendered = html('The web server is running but the Rounds API behind it did not respond. Check that the API process is up.');

  it('names the API, not the credentials', () => {
    expect(rendered).toContain('reach its API');
    expect(rendered).toContain('API process is up');
  });

  it('says explicitly that signing in will not help', () => {
    // Without this line someone still hunts for the login page, because that
    // is what they were looking at a moment ago.
    expect(rendered).toContain('not a sign-in problem');
  });

  it('offers a way back rather than being terminal', () => {
    expect(rendered).toContain('Try again');
  });

  it('passes the detail through rather than restating it', () => {
    expect(html('Cannot reach the Rounds API. Check that the API server is running.'))
      .toContain('Check that the API server is running');
  });
});

import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { renderSql } from './query-client.js';

describe('renderSql()', () => {
  // Regression: a previous version rewrote `FROM user` -> `FROM "user"` etc.
  // with a regex on the rendered SQL. The user table has since been renamed
  // to `users`, so renderSql must pass the SQL through unchanged.
  it('does not rewrite the literal substring "FROM user"', () => {
    const { text } = renderSql(sql`SELECT * FROM user WHERE id = ${'u1'}`);
    expect(text).toContain('FROM user');
    expect(text).not.toContain('FROM "user"');
  });

  it('does not rewrite INTO/UPDATE/DELETE/JOIN user', () => {
    expect(renderSql(sql`INSERT INTO user (id) VALUES (${'x'})`).text).toContain('INTO user');
    expect(renderSql(sql`UPDATE user SET id = ${'x'}`).text).toContain('UPDATE user');
    expect(renderSql(sql`DELETE FROM user WHERE id = ${'x'}`).text).toContain('DELETE FROM user');
    expect(renderSql(sql`SELECT 1 FROM x JOIN user u ON 1=1`).text).toContain('JOIN user');
  });

  it('parameterises values with $1, $2, ...', () => {
    const { text, params } = renderSql(sql`SELECT ${'a'}, ${'b'}`);
    expect(text).toContain('$1');
    expect(text).toContain('$2');
    expect(params).toEqual(['a', 'b']);
  });
});

import { DSLD_BASE_URL } from './dsld-label-lookup';
import { DSLD_ORIGIN, redactDsldQueryAttributes } from './span-redaction';

describe('redactDsldQueryAttributes (#1381)', () => {
  const run = (origin: string, path: string) => redactDsldQueryAttributes({ origin, path });

  it("replaces a label search's query values in url.full and url.query", () => {
    const attrs = run(DSLD_ORIGIN, '/dsld/v9/search-filter?q=Zorblax%20Blend&size=3');
    expect(attrs).toEqual({
      'url.full': 'https://api.ods.od.nih.gov/dsld/v9/search-filter?q=:value&size=:value',
      'url.query': '?q=:value&size=:value',
    });
    expect(JSON.stringify(attrs)).not.toContain('Zorblax');
  });

  it('leaves a label fetch and other origins alone', () => {
    expect(run(DSLD_ORIGIN, '/dsld/v9/label/43261')).toEqual({});
    expect(run('https://example.com', '/dsld/v9/search-filter?q=x')).toEqual({});
  });

  it('covers the origin the lookup calls', () => {
    expect(new URL(DSLD_BASE_URL).origin).toBe(DSLD_ORIGIN);
  });
});

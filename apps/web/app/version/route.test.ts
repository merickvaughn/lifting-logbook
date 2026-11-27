/**
 * @jest-environment node
 */
import { GET } from './route';
import { resolveDeploymentEnvironment } from '../../lib/deployment-environment';

// process.env is typed with a readonly NODE_ENV; this view lets the tests set it.
const env = process.env as Record<string, string | undefined>;

function restore(name: string, value: string | undefined) {
  if (value === undefined) {
    delete env[name];
  } else {
    env[name] = value;
  }
}

describe('resolveDeploymentEnvironment', () => {
  it('uses the value verbatim when set', () => {
    expect(resolveDeploymentEnvironment('production')).toBe('production');
    expect(resolveDeploymentEnvironment('staging')).toBe('staging');
  });

  it('trims surrounding whitespace', () => {
    expect(resolveDeploymentEnvironment('  staging  ')).toBe('staging');
  });

  it('falls back to "development" when the value is blank', () => {
    expect(resolveDeploymentEnvironment('')).toBe('development');
    expect(resolveDeploymentEnvironment('   ')).toBe('development');
  });
});

describe('/version GET', () => {
  const originalGitSha = process.env.GIT_SHA;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDeploymentEnv = process.env.DEPLOYMENT_ENVIRONMENT;

  afterEach(() => {
    restore('GIT_SHA', originalGitSha);
    restore('NODE_ENV', originalNodeEnv);
    restore('DEPLOYMENT_ENVIRONMENT', originalDeploymentEnv);
  });

  it('returns the GIT_SHA and DEPLOYMENT_ENVIRONMENT from process.env', async () => {
    env.GIT_SHA = 'abc1234';
    env.DEPLOYMENT_ENVIRONMENT = 'staging';

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      gitSha: 'abc1234',
      environment: 'staging',
    });
  });

  // #1448: a Next production build runs with NODE_ENV=production wherever it is
  // deployed, so reading NODE_ENV made staging answer "production". With
  // DEPLOYMENT_ENVIRONMENT absent, the route must not claim production.
  it('does not report "production" from NODE_ENV when DEPLOYMENT_ENVIRONMENT is unset', async () => {
    env.NODE_ENV = 'production';
    delete env.DEPLOYMENT_ENVIRONMENT;

    const body = await (await GET()).json();

    expect(body.environment).not.toBe('production');
    expect(body.environment).toBe('development');
  });

  it('reports staging on a production build deployed to staging', async () => {
    env.NODE_ENV = 'production';
    env.DEPLOYMENT_ENVIRONMENT = 'staging';

    expect((await (await GET()).json()).environment).toBe('staging');
  });

  it('degrades to gitSha "unknown" when GIT_SHA is not set, rather than throwing', async () => {
    delete process.env.GIT_SHA;

    const res = await GET();

    expect(res.status).toBe(200);
    expect((await res.json()).gitSha).toBe('unknown');
  });

  it('degrades to gitSha "unknown" when GIT_SHA is an empty string (Docker ARG-with-no-value case)', async () => {
    // A `docker build` without --build-arg GIT_SHA=... yields an empty string,
    // not undefined — `??` would let this through unchanged; `||` catches it.
    process.env.GIT_SHA = '';

    const res = await GET();

    expect((await res.json()).gitSha).toBe('unknown');
  });
});

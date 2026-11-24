import {
  DEPLOYMENT_ENVIRONMENT_ATTR,
  buildResourceAttributesEnv,
  resolveDeploymentEnvironment,
  buildLogRecordProcessors,
  UNDICI_INSTRUMENTATION_CONFIG,
} from './otel';

// The outbound-HTTP spans startOtel() creates must not carry user data in their URL: a Sheets
// spreadsheet ID (#1432) or a typed supplement name sent to the NIH label database (#1381).
describe('UNDICI_INSTRUMENTATION_CONFIG.startSpanHook', () => {
  const hook = (origin: string, path: string) => UNDICI_INSTRUMENTATION_CONFIG.startSpanHook({ origin, path });

  it('redacts the typed name from a label search URL', () => {
    const attrs = hook('https://api.ods.od.nih.gov', '/dsld/v9/search-filter?q=Zorblax&size=3');
    expect(attrs['url.full']).toBe('https://api.ods.od.nih.gov/dsld/v9/search-filter?q=:value&size=:value');
    expect(attrs['url.query']).toBe('?q=:value&size=:value');
    expect(JSON.stringify(attrs)).not.toContain('Zorblax');
  });

  it('still redacts a Sheets spreadsheet ID', () => {
    expect(JSON.stringify(hook('https://sheets.googleapis.com', '/v4/spreadsheets/1AbcSecretId?fields=x'))).not.toContain('1AbcSecretId');
  });

  it('adds nothing for other calls', () => {
    expect(hook('https://example.com', '/path?q=x')).toEqual({});
  });
});

// Regression coverage for #487: the API must tag telemetry with a deployment
// environment so the production alert rules (infra/observability/alerts/api.yaml)
// can scope to prod and a staging 5xx never pages on the shared Grafana Cloud
// stack. These assertions lock the resource attribute the collector promotes to
// the `deployment_environment_name` Mimir label.
describe('resolveDeploymentEnvironment', () => {
  it('uses NODE_ENV verbatim when set', () => {
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

  it('reads process.env.NODE_ENV by default, falling back to "development" when unset', () => {
    const original = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(resolveDeploymentEnvironment()).toBe('production');
      process.env.NODE_ENV = '';
      expect(resolveDeploymentEnvironment()).toBe('development');
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});

describe('buildResourceAttributesEnv', () => {
  it('emits a deployment.environment.name=<env> pair from NODE_ENV', () => {
    expect(buildResourceAttributesEnv(undefined, 'production')).toBe(
      'deployment.environment.name=production',
    );
  });

  it('appends to a pre-existing OTEL_RESOURCE_ATTRIBUTES value, preserving it', () => {
    expect(
      buildResourceAttributesEnv('service.namespace=lifting', 'staging'),
    ).toBe('service.namespace=lifting,deployment.environment.name=staging');
  });

  it('treats a blank pre-existing value as empty (no leading comma)', () => {
    expect(buildResourceAttributesEnv('   ', 'production')).toBe(
      'deployment.environment.name=production',
    );
  });

  it('falls back to development when the resolved environment is blank', () => {
    expect(buildResourceAttributesEnv(undefined, '')).toBe(
      'deployment.environment.name=development',
    );
  });

  it('uses the stable semconv attribute key', () => {
    expect(DEPLOYMENT_ENVIRONMENT_ATTR).toBe('deployment.environment.name');
  });
});

// Regression coverage for #662: startOtel() must wire a log record processor,
// or structured logs (including the err.message/err.stack detail the #648 RLS
// alert depends on) silently never reach the collector's logs pipeline despite
// it being fully configured to receive them. otel-log-redaction.spec.ts proves
// the underlying mechanism is redaction-safe; this proves otel.ts actually uses it.
describe('buildLogRecordProcessors', () => {
  it('returns at least one processor so structured logs reach the OTel Logs pipeline', async () => {
    const processors = buildLogRecordProcessors();
    expect(processors.length).toBeGreaterThan(0);
    await Promise.all(processors.map((p) => p.shutdown()));
  });
});

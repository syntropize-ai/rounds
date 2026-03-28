// Scaffold template - generates a new adapter project skeleton

export interface ScaffoldOptions {
  /** Adapter name, e.g. "my-service" -> generates "my-service" adapter */
  name: string;
  /** Output directory path */
  outputDir: string;
}

export interface ScaffoldFile {
  path: string;
  content: string;
}

/**
 * Generate the scaffold files for a new adapter project.
 * Returns an array of file descriptors to be written to disk.
 */
export function generateScaffold(options: ScaffoldOptions): ScaffoldFile[] {
  const { name } = options;
  const className = toPascalCase(name) + 'Adapter';
  const actionPrefix = name.toLowerCase().replace(/[^a-z0-9]/g, '-');

  return [
    {
      path: 'package.json',
      content: JSON.stringify({
        name: `@my-org/adapter-${name}`,
        version: '0.1.0',
        type: 'module',
        main: './dist/index.js',
        types: './dist/index.d.ts',
        exports: {
          '.': {
            import: './dist/index.js',
            types: './dist/index.d.ts',
          },
        },
        scripts: {
          build: 'tsc --build',
          test: 'vitest run',
        },
        dependencies: {
          '@agentic-obs/adapter-sdk': '*',
          '@agentic-obs/agent-core': '*',
        },
        devDependencies: {
          typescript: '^5.4.0',
          vitest: '^1.6.0',
        },
      }, null, 2),
    },
    {
      path: 'tsconfig.json',
      content: JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          declaration: true,
          outDir: 'dist',
          rootDir: 'src',
        },
        include: ['src/**/*.ts'],
        exclude: ['node_modules', 'dist'],
      }, null, 2),
    },
    {
      path: 'manifest.json',
      content: JSON.stringify({
        name: actionPrefix,
        version: '0.1.0',
        description: `${name} execution adapter`,
        capabilities: [`${actionPrefix}:execute`, `${actionPrefix}:restart`],
        configSchema: {
          properties: {
            apiUrl: {
              type: 'string',
              description: 'Base URL for the API',
              required: true,
            },
            apiToken: {
              type: 'string',
              description: 'Authentication token',
              required: true,
            },
          },
          required: ['apiUrl', 'apiToken'],
        },
        supportsDryRun: true,
        supportsRollback: false,
      }, null, 2),
    },
    {
      path: `src/${name}-adapter.ts`,
      content: `import { BaseAdapter } from '@agentic-obs/adapter-sdk';
import type { AdapterAction, ExecutionResult } from '@agentic-obs/agent-core';
import type { AdapterManifest } from '@agentic-obs/adapter-sdk';
import manifest from '../manifest.json' assert { type: 'json' };

export interface ${className}Config {
  apiUrl: string;
  apiToken: string;
}

export class ${className} extends BaseAdapter {
  private readonly config: ${className}Config;

  constructor(config: ${className}Config) {
    super();
    this.config = config;
  }

  manifest(): AdapterManifest {
    return manifest as AdapterManifest;
  }

  protected async doExecute(action: AdapterAction): Promise<ExecutionResult> {
    const executionId = this.generateExecutionId();

    // TODO: Implement actual execution against ${name} API
    // Example: call this.config.apiUrl with action.params
    console.log(\`Executing \${action.type} on \${action.targetService} via ${name}\`);

    return {
      success: true,
      output: { actionType: action.type, targetService: action.targetService },
      rollbackable: false,
      executionId,
    };
  }
}`,
    },
    {
      path: 'src/index.ts',
      content: `export { ${className} } from './${name}-adapter.js';
export type { ${className}Config } from './${name}-adapter.js';`,
    },
    {
      path: `src/__tests__/${name}-adapter.test.ts`,
      content: `import { describe, it, expect, beforeEach } from 'vitest';
import { ${className} } from '../${name}-adapter.js';
import { AdapterValidator } from '@agentic-obs/adapter-sdk';

describe('${className}', () => {
  let adapter: ${className};
  let validator: AdapterValidator;

  beforeEach(() => {
    adapter = new ${className}({ apiUrl: 'https://api.example.com', apiToken: 'test-token' });
    validator = new AdapterValidator();
  });

  it('should pass adapter validation', () => {
    const result = validator.validateAdapter(adapter);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should declare capabilities', () => {
    const caps = adapter.capabilities();
    expect(caps.length).toBeGreaterThan(0);
    expect(caps.every(c => c.includes(':'))).toBe(true);
  });

  it('should reject unsupported action types', async () => {
    const result = await adapter.validate({
      type: 'unsupported:action',
      params: {},
      targetService: 'test-svc',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not supported');
  });

  it('should execute a supported action', async () => {
    const cap = adapter.capabilities()[0]!;
    const result = await adapter.execute({
      type: cap,
      params: {},
      targetService: 'test-svc',
    });
    expect(result.success).toBe(true);
    expect(result.executionId).toBeTruthy();
  });
});`,
    },
  ];
}

function toPascalCase(str: string): string {
  return str
    .split(/[-_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}
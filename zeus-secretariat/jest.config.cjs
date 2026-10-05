/**
 * Jest configuration for zeus-secretariat.
 *
 * NOTE: this package is an ES module ("type": "module" in package.json), so
 * the config file must use the `.cjs` extension (a plain `jest.config.js`
 * fails with "module is not defined in ES module scope"). Tests are written
 * as ESM TypeScript and transformed by ts-jest in ESM mode; run via
 * `NODE_OPTIONS=--experimental-vm-modules jest`.
 */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'esnext',
          target: 'es2022',
          moduleResolution: 'bundler',
          esModuleInterop: true,
          allowJs: true,
          isolatedModules: true,
          strict: false,
          skipLibCheck: true,
        },
      },
    ],
  },
  moduleNameMapper: {
    '^@workspace/db$': '<rootDir>/../lib/db/src/index.ts',
    '^@workspace/db/schema$': '<rootDir>/../lib/db/src/schema/index.ts',
    '^@workspace/db/(.*)$': '<rootDir>/../lib/db/src/$1.ts',
    '^zeus-secretariat$': '<rootDir>/src/index.ts',
    '^express$': '<rootDir>/../api-server/node_modules/express',
    '^zod$': '<rootDir>/../api-server/node_modules/zod',
  },
  resolver: '<rootDir>/jest.resolver.cjs',
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
  ],
};

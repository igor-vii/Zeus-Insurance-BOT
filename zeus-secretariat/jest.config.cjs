/* CommonJS mirror of jest.config.js (package is "type": "module", so a .js
 * config file cannot use module.exports). Adds the ts-jest ESM preset so
 * TypeScript ESM tests using `import` run under Jest 29. */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/jest.setup.cjs'],
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^@workspace/db$': '<rootDir>/../lib/db/src/index.ts',
    '^@workspace/db/schema$': '<rootDir>/../lib/db/src/schema/index.ts',
    // R0 repair: tests import deep subpaths (e.g. @workspace/db/secretariat/postgres-store)
    // that the package "exports" map does not declare — map them onto TS sources.
    '^@workspace/db/secretariat/(.*)$': '<rootDir>/../lib/db/src/secretariat/$1',
    '^@workspace/db/schema/(.*)$': '<rootDir>/../lib/db/src/schema/$1',
    '^@workspace/db/(.*)$': '<rootDir>/../lib/db/src/$1',
    '^zeus-secretariat$': '<rootDir>/src/index.ts',
    '^zeus-secretariat/(.*)$': '<rootDir>/src/$1',
    '^express$': '<rootDir>/../api-server/node_modules/express',
    '^zod$': '<rootDir>/../api-server/node_modules/zod',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: true }],
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
  ],
};

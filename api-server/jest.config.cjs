/* api-server Jest runner (R4): the two BLOCK 8 R2 suites under src/tests were
 * authored for Jest (jest.mock/describe/expect) but never wired to a runner —
 * they sat dead in the repo and rotted out of the typecheck. This config
 * mirrors zeus-secretariat's (ESM preset + jest.setup.cjs global restore),
 * with workspace sources mapped so tests compile against TS, not dist. */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/jest.setup.cjs'],
  roots: ['<rootDir>/src/tests'],
  testMatch: ['**/*.test.ts'],
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^@workspace/db$': '<rootDir>/../lib/db/src/index.ts',
    '^@workspace/db/schema$': '<rootDir>/../lib/db/src/schema/index.ts',
    '^@workspace/db/(.*)$': '<rootDir>/../lib/db/src/$1',
    '^zeus-secretariat/adapters/local-eoa-signer$': '<rootDir>/../zeus-secretariat/src/adapters/local-eoa-signer.ts',
    '^zeus-secretariat/core/types$': '<rootDir>/../zeus-secretariat/src/core/types.ts',
    '^zeus-secretariat/(.*)$': '<rootDir>/../zeus-secretariat/src/$1',
    '^zeus-secretariat$': '<rootDir>/../zeus-secretariat/src/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: true }],
  },
};

/* CommonJS jest config (package is "type": "module", so a .js config cannot
 * use module.exports). Mirrors zeus-secretariat's ESM ts-jest preset.
 * Pure unit tests — no network, no database: RPC is injected as fakes. */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^zeus-facilitator$': '<rootDir>/src/index.ts',
    '^zeus-facilitator/(.*)$': '<rootDir>/src/$1',
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

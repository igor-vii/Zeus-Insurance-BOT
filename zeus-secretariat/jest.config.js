module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  // R2.1-FIX-5-REPAIR-3F: Allow ts-jest to transform ESM-only packages.
  // drizzle-orm@0.45.2 ships ESM with exports map; without this,
  // Jest skips transformation and CJS runtime cannot resolve named exports.
  transformIgnorePatterns: [
    '/node_modules/(?!(drizzle-orm|@workspace)/)',
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
  ],
};

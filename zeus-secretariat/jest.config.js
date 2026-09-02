module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  // R2.1-FIX-5-REPAIR-3H: Force CJS resolution for drizzle-orm.
  // drizzle-orm@0.45.2 ships dual CJS/ESM builds. Jest runs in CJS mode
  // and cannot properly load the ESM .mjs entries. Map to official CJS builds.
  moduleNameMapper: {
    '^drizzle-orm$': 'drizzle-orm/index.cjs',
    '^drizzle-orm/pg-core$': 'drizzle-orm/pg-core/index.cjs',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
  ],
};

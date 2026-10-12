module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  moduleNameMapper: {
    '^@workspace/db$': '<rootDir>/../lib/db/src/index.ts',
    '^@workspace/db/schema$': '<rootDir>/../lib/db/src/schema/index.ts',
    '^zeus-secretariat$': '<rootDir>/src/index.ts',
    '^zeus-secretariat/(.*)$': '<rootDir>/src/$1',
    '^express$': '<rootDir>/../api-server/node_modules/express',
    '^zod$': '<rootDir>/../api-server/node_modules/zod',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
  ],
};
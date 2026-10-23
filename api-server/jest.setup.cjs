/* Jest ESM mode disables automatic `jest` global injection. Restore it for
 * existing tests that call jest.fn()/jest.mock() without importing
 * @jest/globals. */
const jestObj = require('@jest/globals').jest;
Object.defineProperty(globalThis, 'jest', { value: jestObj, writable: true });

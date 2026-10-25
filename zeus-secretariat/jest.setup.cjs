/* Jest ESM mode disables automatic `jest` global injection. Restore it for
 * existing tests that call jest.fn()/jest.mock() without importing
 * @jest/globals. */
const jestObj = require('@jest/globals').jest;
Object.defineProperty(globalThis, 'jest', { value: jestObj, writable: true });

// F-09 egress guard: unit tests exercise real flows against MOCKED fetch and
// fictional hosts (api.example.com, paid-seller.example...) that would fail
// the default block-private DNS check. Test rigs run with the documented
// allow-all escape; the dedicated f09-egress-guard suite sets its own policy
// per test and is unaffected. Production default remains block-private.
process.env.ZEUS_EGRESS_POLICY = 'allow-all';

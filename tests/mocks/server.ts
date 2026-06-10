// Shared MSW server for the API tests.
// We fake the network at the boundary (per the testing doctrine, Rule 2): the
// real axios client + interceptors run; only the wire is faked. Tests add
// per-test handlers with `server.use(...)`.
import { setupServer } from 'msw/node';

export const server = setupServer();

/**
 * Register the MSW server lifecycle for the calling test file.
 * `onUnhandledRequest: 'error'` makes any un-mocked request fail loudly, which
 * is what turns these into contract tests (drift can't pass silently).
 */
export function installMswServer(): void {
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
}

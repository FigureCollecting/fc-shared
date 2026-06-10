// Shared test setup.
// Provides a localStorage shim so zustand's `persist` middleware (used by the
// auth store) runs under the node test environment without a real DOM.
const memory: Record<string, string> = {};

const localStorageMock: Storage = {
  get length() {
    return Object.keys(memory).length;
  },
  clear: () => {
    for (const key of Object.keys(memory)) delete memory[key];
  },
  getItem: (key: string) => (key in memory ? memory[key] : null),
  key: (index: number) => Object.keys(memory)[index] ?? null,
  removeItem: (key: string) => {
    delete memory[key];
  },
  setItem: (key: string, value: string) => {
    memory[key] = String(value);
  },
};

const testGlobal = globalThis as unknown as {
  localStorage: Storage;
  window: { localStorage: Storage };
};
testGlobal.localStorage = localStorageMock;
testGlobal.window = { localStorage: localStorageMock };

// Typed, valid-by-default test-data builders (testing doctrine §11 "Test-data
// builders"). Each builder returns a complete object typed against the shared
// contract in src/types, so a contract change to a required field breaks these
// builders at compile time (`npm run lint` = strict `tsc --noEmit` over tests/)
// instead of drifting silently — this is the Rule 4 compile-error guarantee.
import {
  Figure,
  MfcList,
  MfcSyncStats,
  MfcQueueStats,
  MfcParsedItem,
} from '../../src/types';

export const aFigure = (overrides: Partial<Figure> = {}): Figure => ({
  _id: 'fig-1',
  manufacturer: 'Good Smile Company',
  name: 'Saber',
  scale: '1/7',
  userId: 'user-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  ...overrides,
});

export const anMfcList = (overrides: Partial<MfcList> = {}): MfcList => ({
  _id: 'list-1',
  mfcId: 4242,
  userId: 'user-1',
  name: 'Fate Collection',
  privacy: 'public',
  allowComments: true,
  mailOnSales: false,
  mailOnHunts: false,
  itemCount: 0,
  itemMfcIds: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  ...overrides,
});

export const syncStats = (overrides: Partial<MfcSyncStats> = {}): MfcSyncStats => ({
  owned: 0,
  ordered: 0,
  wished: 0,
  total: 0,
  nsfw: 0,
  ...overrides,
});

export const anMfcQueueStats = (overrides: Partial<MfcQueueStats> = {}): MfcQueueStats => ({
  queues: { hot: 0, warm: 0, cold: 0 },
  total: 0,
  processing: 0,
  completed: 0,
  failed: 0,
  rateLimit: { active: false, currentDelayMs: 0 },
  ...overrides,
});

export const anMfcParsedItem = (overrides: Partial<MfcParsedItem> = {}): MfcParsedItem => ({
  mfcId: 'mfc-1',
  name: 'Saber',
  status: 'owned',
  isNsfw: false,
  ...overrides,
});

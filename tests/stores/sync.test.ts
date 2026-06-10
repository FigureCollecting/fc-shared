import { useSyncStore, RecoveredJobData } from '../../src/stores/sync';
import { SyncJobStats } from '../../src/types';

const sampleStats: SyncJobStats = {
  total: 10,
  pending: 2,
  processing: 1,
  completed: 5,
  failed: 1,
  skipped: 1,
};

const recovered: RecoveredJobData = {
  sessionId: 'orphan-1',
  phase: 'enriching',
  message: 'resuming',
  stats: { total: 5, pending: 0, processing: 0, completed: 5, failed: 0, skipped: 0 },
  startedAt: '2024-01-01',
};

describe('useSyncStore', () => {
  beforeEach(() => {
    useSyncStore.getState().reset();
  });

  it('starts a session in the connecting state with zeroed stats', () => {
    useSyncStore.getState().startSync('sess-1');
    const s = useSyncStore.getState();
    expect(s.sessionId).toBe('sess-1');
    expect(s.isActive).toBe(true);
    expect(s.connectionState).toBe('connecting');
    expect(s.phase).toBe('validating');
    expect(s.stats).toEqual({ total: 0, pending: 0, processing: 0, completed: 0, failed: 0, skipped: 0 });
    expect(s.failedItems).toEqual([]);
  });

  it('flags an orphaned session and clears it when set to null', () => {
    useSyncStore.getState().setOrphanedSession(recovered);
    expect(useSyncStore.getState().hasOrphanedSession).toBe(true);
    expect(useSyncStore.getState().orphanedSessionData).toEqual(recovered);

    useSyncStore.getState().setOrphanedSession(null);
    expect(useSyncStore.getState().hasOrphanedSession).toBe(false);
    expect(useSyncStore.getState().orphanedSessionData).toBeNull();
  });

  it('recovers an orphaned session into active tracking, falling back when message is empty', () => {
    useSyncStore.getState().recoverSession({ ...recovered, message: '' });
    const s = useSyncStore.getState();
    expect(s.sessionId).toBe('orphan-1');
    expect(s.isActive).toBe(true);
    expect(s.hasOrphanedSession).toBe(false);
    expect(s.connectionState).toBe('connecting');
    expect(s.message).toBe('Reconnecting...');
  });

  it('dismisses an orphaned session without recovering it', () => {
    useSyncStore.getState().setOrphanedSession(recovered);
    useSyncStore.getState().dismissOrphanedSession();
    expect(useSyncStore.getState().hasOrphanedSession).toBe(false);
    expect(useSyncStore.getState().orphanedSessionData).toBeNull();
  });

  it('updates the SSE connection state', () => {
    useSyncStore.getState().updateConnectionState('connected');
    expect(useSyncStore.getState().connectionState).toBe('connected');
  });

  it('updates progress and preserves the prior message when none is supplied', () => {
    useSyncStore.getState().updateProgress('enriching', sampleStats, 'halfway');
    expect(useSyncStore.getState().message).toBe('halfway');

    useSyncStore.getState().updateProgress('completed', sampleStats);
    expect(useSyncStore.getState().phase).toBe('completed');
    expect(useSyncStore.getState().message).toBe('halfway');
  });

  it('appends failed items in order', () => {
    useSyncStore.getState().addFailedItem('mfc-1', 'boom');
    useSyncStore.getState().addFailedItem('mfc-2');
    expect(useSyncStore.getState().failedItems).toEqual([
      { mfcId: 'mfc-1', error: 'boom' },
      { mfcId: 'mfc-2', error: undefined },
    ]);
  });

  it('sets and clears the error', () => {
    const err = new Error('nope');
    useSyncStore.getState().setError(err);
    expect(useSyncStore.getState().error).toBe(err);
    useSyncStore.getState().setError(null);
    expect(useSyncStore.getState().error).toBeNull();
  });

  it('sets the paused flag', () => {
    useSyncStore.getState().setIsPaused(true);
    expect(useSyncStore.getState().isPaused).toBe(true);
  });

  describe('completeSync', () => {
    it('completes with the provided stats and disconnects', () => {
      useSyncStore.getState().completeSync('completed', sampleStats, 'done');
      const s = useSyncStore.getState();
      expect(s.phase).toBe('completed');
      expect(s.stats).toEqual(sampleStats);
      expect(s.isActive).toBe(false);
      expect(s.connectionState).toBe('disconnected');
      expect(s.message).toBe('done');
    });

    it('preserves existing stats when none are provided (cancelled path)', () => {
      useSyncStore.getState().updateProgress('enriching', sampleStats);
      useSyncStore.getState().completeSync('cancelled', undefined as unknown as SyncJobStats);
      expect(useSyncStore.getState().stats).toEqual(sampleStats);
    });
  });

  it('cancels an active sync', () => {
    useSyncStore.getState().startSync('sess-x');
    useSyncStore.getState().cancelSync();
    const s = useSyncStore.getState();
    expect(s.phase).toBe('cancelled');
    expect(s.isActive).toBe(false);
    expect(s.connectionState).toBe('disconnected');
  });

  it('resets all state back to the initial shape', () => {
    useSyncStore.getState().startSync('sess-y');
    useSyncStore.getState().addFailedItem('m');
    useSyncStore.getState().reset();
    const s = useSyncStore.getState();
    expect(s.sessionId).toBeNull();
    expect(s.isActive).toBe(false);
    expect(s.stats).toBeNull();
    expect(s.failedItems).toEqual([]);
  });
});

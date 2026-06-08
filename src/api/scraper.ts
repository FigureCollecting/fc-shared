/**
 * Scraper Service API Client
 *
 * Handles communication with the scraper service for MFC sync operations.
 * Functions accept an axios instance created by createSimpleApiClient().
 */

import { AxiosInstance } from 'axios';
import {
  MfcCookies,
  MfcCookieValidationResult,
  MfcSyncResult,
  MfcQueueStats,
  MfcParsedItem,
  MfcSyncStats,
} from '../types';
import { createLogger } from '../utils/logger';

const logger = createLogger('SCRAPER_API');

// ============================================================================
// Cookie Configuration
// ============================================================================

export interface CookieAllowlistResponse {
  allowedCookies: string[];
  scriptReadable: string[];
  manualCopy: string[];
}

/**
 * Get the MFC cookie allowlist from the scraper service.
 */
export const getMfcCookieAllowlist = async (api: AxiosInstance): Promise<CookieAllowlistResponse> => {
  logger.info('Fetching MFC cookie allowlist...');

  const response = await api.get('/sync/mfc/cookie-allowlist');

  if (!response.data.success) {
    throw new Error(response.data.message || 'Failed to get cookie allowlist');
  }

  return response.data.data;
};

// ============================================================================
// Cookie Validation
// ============================================================================

/**
 * Validate MFC session cookies
 */
export const validateMfcCookies = async (
  api: AxiosInstance,
  cookies: MfcCookies
): Promise<MfcCookieValidationResult> => {
  logger.info('Validating MFC cookies...');

  const response = await api.post('/sync/validate-cookies', { cookies });

  if (!response.data.success) {
    throw new Error(response.data.message || 'Cookie validation failed');
  }

  return response.data.data;
};

// ============================================================================
// Full Sync
// ============================================================================

export interface FullSyncOptions {
  cookies: MfcCookies;
  userId: string;
  sessionId: string;
  includeLists?: boolean;
  skipCached?: boolean;
  /** Filter by collection status (owned/ordered/wished) - if empty, sync all */
  statusFilter?: ('owned' | 'ordered' | 'wished')[];
}

/**
 * Execute full MFC sync: validate -> export -> parse -> queue
 */
export const executeFullSync = async (
  api: AxiosInstance,
  options: FullSyncOptions
): Promise<MfcSyncResult> => {
  logger.info('Starting full MFC sync...');

  const response = await api.post('/sync/full', {
    cookies: options.cookies,
    userId: options.userId,
    sessionId: options.sessionId,
    includeLists: options.includeLists ?? false,
    skipCached: options.skipCached ?? true,
    statusFilter: options.statusFilter,
  });

  if (!response.data.success) {
    throw new Error(response.data.message || 'Full sync failed');
  }

  logger.info('Full sync result:', response.data.data);

  return {
    success: true,
    parsedCount: response.data.data.parsedCount,
    queuedCount: response.data.data.queuedCount,
    skippedCount: response.data.data.skippedCount,
    listsFound: response.data.data.listsFound,
    stats: response.data.data.stats,
    errors: response.data.data.errors || [],
  };
};

// ============================================================================
// CSV Sync
// ============================================================================

export interface CsvSyncOptions {
  csvContent: string;
  userId: string;
  cookies?: MfcCookies;
  sessionId?: string;
}

/**
 * Sync from user-provided CSV content
 */
export const syncFromCsv = async (
  api: AxiosInstance,
  options: CsvSyncOptions
): Promise<MfcSyncResult> => {
  logger.info('Starting CSV sync...');

  const response = await api.post('/sync/from-csv', {
    csvContent: options.csvContent,
    userId: options.userId,
    cookies: options.cookies,
    sessionId: options.sessionId,
  });

  if (!response.data.success) {
    throw new Error(response.data.message || 'CSV sync failed');
  }

  logger.info('CSV sync result:', response.data.data);

  return {
    success: true,
    parsedCount: response.data.data.parsedCount,
    queuedCount: response.data.data.queuedCount,
    skippedCount: response.data.data.skippedCount,
    stats: response.data.data.stats,
    errors: response.data.data.errors || [],
  };
};

// ============================================================================
// CSV Parsing (without queueing)
// ============================================================================

export interface ParseCsvResult {
  items: MfcParsedItem[];
  stats: MfcSyncStats;
}

/**
 * Parse CSV content and return items without queueing
 */
export const parseMfcCsv = async (api: AxiosInstance, csvContent: string): Promise<ParseCsvResult> => {
  logger.info('Parsing MFC CSV...');

  const response = await api.post('/sync/parse-csv', { csvContent });

  if (!response.data.success) {
    throw new Error(response.data.message || 'CSV parsing failed');
  }

  return response.data.data;
};

// ============================================================================
// Queue Status
// ============================================================================

/**
 * Get current queue status and statistics
 */
export const getQueueStats = async (api: AxiosInstance): Promise<MfcQueueStats> => {
  logger.verbose('Fetching queue stats...');

  const response = await api.get('/sync/queue-stats');

  if (!response.data.success) {
    throw new Error(response.data.message || 'Failed to get queue stats');
  }

  return response.data.data;
};

/**
 * Get sync status (overall status and queue info)
 */
export const getSyncStatus = async (api: AxiosInstance): Promise<{
  queueStats: MfcQueueStats;
  isProcessing: boolean;
}> => {
  logger.verbose('Fetching sync status...');

  const response = await api.get('/sync/status');

  if (!response.data.success) {
    throw new Error(response.data.message || 'Failed to get sync status');
  }

  return response.data.data;
};

// ============================================================================
// Sync Job Management
// ============================================================================

export interface CreateSyncJobOptions {
  sessionId: string;
  includeLists?: boolean;
  statusFilter?: ('owned' | 'ordered' | 'wished')[];
  skipCached?: boolean;
}

export interface CreateSyncJobResult {
  job: {
    sessionId: string;
    phase: string;
    message: string;
  };
  webhookUrl: string;
  webhookSecret: string;
  existing?: boolean;
}

/**
 * Create a new sync job before starting the sync.
 */
export const createSyncJob = async (
  api: AxiosInstance,
  options: CreateSyncJobOptions
): Promise<CreateSyncJobResult> => {
  logger.info('Creating sync job...');

  const response = await api.post('/sync/job', {
    sessionId: options.sessionId,
    includeLists: options.includeLists,
    statusFilter: options.statusFilter,
    skipCached: options.skipCached,
  });

  if (!response.data.success) {
    throw new Error(response.data.message || 'Failed to create sync job');
  }

  return response.data;
};

/**
 * Get current sync job state (for reconnection).
 */
export const getSyncJob = async (
  api: AxiosInstance,
  sessionId: string
): Promise<{
  sessionId: string;
  phase: string;
  message: string;
  stats: {
    total: number;
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    skipped: number;
  };
  startedAt: string;
  completedAt?: string;
} | null> => {
  logger.verbose('Fetching sync job:', sessionId);

  try {
    const response = await api.get(`/sync/job/${sessionId}`);

    if (!response.data.success) {
      return null;
    }

    return response.data.job;
  } catch (error: any) {
    if (error.response?.status === 404) {
      return null;
    }
    throw error;
  }
};

/**
 * Active job response from the backend.
 */
export interface ActiveJobResponse {
  success: boolean;
  hasActiveJob: boolean;
  job?: {
    sessionId: string;
    phase: string;
    message: string;
    stats: {
      total: number;
      pending: number;
      processing: number;
      completed: number;
      failed: number;
      skipped: number;
    };
    startedAt: string;
    completedAt?: string;
  };
}

/**
 * Check if user has an active sync job (for session recovery).
 */
export const getActiveJob = async (api: AxiosInstance): Promise<ActiveJobResponse['job'] | null> => {
  logger.verbose('Checking for active sync job...');

  try {
    const response = await api.get('/sync/active-job');

    if (!response.data.success || !response.data.hasActiveJob) {
      return null;
    }

    logger.info('Found active job:', response.data.job.sessionId);
    return response.data.job;
  } catch (error: any) {
    logger.error('Failed to check for active job:', error.message);
    return null;
  }
};

/**
 * Cancel an active sync job.
 */
export const cancelSyncJob = async (api: AxiosInstance, sessionId: string): Promise<void> => {
  logger.info('Cancelling sync job:', sessionId);

  const response = await api.delete(`/sync/job/${sessionId}`);

  if (!response.data.success) {
    throw new Error(response.data.message || 'Failed to cancel sync job');
  }
};

// ============================================================================
// Session Control Functions
// ============================================================================

/**
 * Session status from the scraper.
 */
export interface SessionStatus {
  sessionId: string;
  isPaused: boolean;
  inCooldown: boolean;
  cooldownRemainingMs?: number;
  consecutiveFailures: number;
  failedMfcIds: string[];
}

/**
 * Get all active sync sessions with their status.
 */
export const getSyncSessions = async (api: AxiosInstance): Promise<{
  sessions: SessionStatus[];
  count: number;
  pausedCount: number;
  inCooldownCount: number;
}> => {
  logger.verbose('Getting sync sessions');

  const response = await api.get('/sync/sessions');

  if (!response.data.success) {
    throw new Error(response.data.message || 'Failed to get sync sessions');
  }

  return response.data.data;
};

/**
 * Resume a paused sync session.
 */
export const resumeSyncSession = async (api: AxiosInstance, sessionId: string): Promise<void> => {
  logger.info('Resuming sync session:', sessionId);

  const response = await api.post(`/sync/sessions/${sessionId}/resume`);

  if (!response.data.success) {
    throw new Error(response.data.message || 'Failed to resume session');
  }
};

/**
 * Cancel failed items for a sync session.
 */
export const cancelFailedItems = async (api: AxiosInstance, sessionId: string): Promise<number> => {
  logger.info('Cancelling failed items for session:', sessionId);

  const response = await api.post(`/sync/sessions/${sessionId}/cancel-failed`);

  if (!response.data.success) {
    throw new Error(response.data.message || 'Failed to cancel failed items');
  }

  return response.data.data.cancelledCount;
};

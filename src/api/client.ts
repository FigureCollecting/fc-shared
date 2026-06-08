/**
 * Shared API Client
 *
 * Framework-agnostic HTTP client using axios with configurable auth.
 * Both desktop (React) and mobile (Preact) can use this by providing
 * their own auth accessor and callbacks.
 */

import axios, { AxiosInstance } from 'axios';
import { createLogger } from '../utils/logger';

const logger = createLogger('API');

// ============================================================================
// Auth Integration Interface
// ============================================================================

/**
 * Interface that consumers must implement to provide auth state.
 * This decouples the API client from any specific state management library.
 */
export interface AuthAccessor {
  /** Get the current access token */
  getToken: () => string | undefined;
  /** Get the current refresh token */
  getRefreshToken: () => string | undefined;
  /** Update tokens after refresh */
  updateTokens: (token: string, refreshToken?: string, tokenExpiresAt?: number) => void;
  /** Record user activity (for session timeout tracking) */
  recordActivity: () => void;
  /** Log out the user */
  logout: () => void;
  /** Called when auth fails and user should be redirected to login */
  onAuthFailure: () => void;
}

// ============================================================================
// Client Configuration
// ============================================================================

export interface ApiClientConfig {
  /** Base URL for the API (e.g., '/api' or 'https://example.com/api') */
  baseUrl: string;
  /** Auth accessor for token management */
  auth: AuthAccessor;
}

// ============================================================================
// Client Factory
// ============================================================================

/**
 * Creates a configured axios instance with auth interceptors.
 *
 * Usage:
 * ```ts
 * const api = createApiClient({
 *   baseUrl: '/api',
 *   auth: {
 *     getToken: () => useAuthStore.getState().user?.token,
 *     getRefreshToken: () => useAuthStore.getState().user?.refreshToken,
 *     updateTokens: (t, r, e) => useAuthStore.getState().updateTokens(t, r, e),
 *     recordActivity: () => useAuthStore.getState().recordActivity(),
 *     logout: () => useAuthStore.getState().logout(),
 *     onAuthFailure: () => { window.location.href = '/login'; },
 *   },
 * });
 * ```
 */
export function createApiClient(config: ApiClientConfig): AxiosInstance {
  const { baseUrl, auth } = config;

  const api = axios.create({
    baseURL: baseUrl,
    headers: {
      'Content-Type': 'application/json',
    },
  });

  // Track if we're currently refreshing to prevent concurrent refresh attempts
  let isRefreshing = false;
  let refreshPromise: Promise<string> | null = null;

  // Add auth token to requests
  api.interceptors.request.use((reqConfig) => {
    const token = auth.getToken();
    if (token) {
      reqConfig.headers.Authorization = `Bearer ${token}`;
    }
    return reqConfig;
  });

  // Handle response errors and token expiration
  api.interceptors.response.use(
    (response) => {
      // Record activity on successful API calls
      auth.recordActivity();

      // Check if we got a new token in response headers
      const newToken = response.headers['x-new-token'] || response.headers['x-access-token'];
      if (newToken) {
        const tokenExpiresAt = Date.now() + (14 * 60 * 1000);
        auth.updateTokens(newToken.replace('Bearer ', ''), undefined, tokenExpiresAt);
      }
      return response;
    },
    async (error) => {
      const originalRequest = error.config;
      const refreshToken = auth.getRefreshToken();
      const token = auth.getToken();

      // Handle 401 Unauthorized (expired/invalid token)
      if (error.response?.status === 401 && !originalRequest._retry) {
        // Don't retry refresh requests themselves
        if (originalRequest.url?.includes('/auth/refresh')) {
          logger.warn('Refresh token invalid, logging out');
          auth.logout();
          auth.onAuthFailure();
          return Promise.reject(error);
        }

        // Try to refresh the token
        if (refreshToken) {
          originalRequest._retry = true;

          try {
            // If already refreshing, wait for that to complete
            if (isRefreshing && refreshPromise) {
              const newToken = await refreshPromise;
              originalRequest.headers.Authorization = `Bearer ${newToken}`;
              return api(originalRequest);
            }

            // Start refresh
            isRefreshing = true;
            logger.verbose('Token expired, attempting refresh...');

            refreshPromise = api.post('/auth/refresh', { refreshToken })
              .then(response => {
                const data = response.data.data;
                const newToken = data.accessToken || data.token;
                const tokenExpiresAt = Date.now() + (14 * 60 * 1000);

                auth.updateTokens(newToken, data.refreshToken, tokenExpiresAt);
                logger.info('Token refreshed successfully');
                return newToken;
              });

            const newToken = await refreshPromise;
            originalRequest.headers.Authorization = `Bearer ${newToken}`;
            return api(originalRequest);

          } catch (refreshError) {
            logger.error('Token refresh failed, logging out');
            auth.logout();
            auth.onAuthFailure();
            return Promise.reject(refreshError);
          } finally {
            isRefreshing = false;
            refreshPromise = null;
          }
        } else {
          // No refresh token, just logout
          auth.logout();
          auth.onAuthFailure();
          return Promise.reject(error);
        }
      }

      // Handle 502/503/504 (backend unavailable) - log but don't redirect
      if (!error.response && token) {
        logger.warn('Network error detected while authenticated - backend may be unavailable');
      } else if ([502, 503, 504].includes(error.response?.status) && token) {
        logger.warn(`Backend unavailable (${error.response.status}) - user may need to re-authenticate`);
      }

      return Promise.reject(error);
    }
  );

  return api;
}

/**
 * Creates a simple axios instance for secondary API endpoints (e.g., scraper/sync)
 * with basic auth token injection but no token refresh logic.
 */
export function createSimpleApiClient(config: {
  baseUrl: string;
  auth: Pick<AuthAccessor, 'getToken'>;
}): AxiosInstance {
  const { baseUrl, auth } = config;

  const api = axios.create({
    baseURL: baseUrl,
    headers: {
      'Content-Type': 'application/json',
    },
  });

  // Add auth token to requests
  api.interceptors.request.use((reqConfig) => {
    const token = auth.getToken();
    if (token) {
      reqConfig.headers.Authorization = `Bearer ${token}`;
    }
    return reqConfig;
  });

  // Handle response errors
  api.interceptors.response.use(
    (response) => response,
    (error) => {
      logger.error('API error:', error.response?.data || error.message);
      return Promise.reject(error);
    }
  );

  return api;
}

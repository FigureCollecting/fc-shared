/**
 * Auth Store - Shared authentication state
 *
 * Framework-agnostic Zustand store for auth state management.
 * Desktop and mobile apps can extend this with platform-specific
 * logout side effects (cookie clearing, theme syncing, etc.)
 * by providing callbacks via configureAuthStore().
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User, TwoFactorPendingState } from '../types';

// ============================================================================
// Platform-specific callbacks (set by consuming app)
// ============================================================================

interface AuthStoreCallbacks {
  /** Called on logout - use for clearing cookies, etc. */
  onLogout?: (userId?: string) => void;
  /** Called when user is set - use for theme syncing, etc. */
  onUserSet?: (user: User | null) => void;
}

let callbacks: AuthStoreCallbacks = {};

/**
 * Configure platform-specific auth store callbacks.
 * Call this at app startup before any auth operations.
 *
 * Example (desktop):
 * ```ts
 * configureAuthStore({
 *   onLogout: (userId) => clearSessionCookies(userId),
 *   onUserSet: (user) => {
 *     if (user?.colorProfile) {
 *       useThemeStore.getState().setColorProfile(user.colorProfile);
 *     }
 *   },
 * });
 * ```
 */
export function configureAuthStore(opts: AuthStoreCallbacks): void {
  callbacks = opts;
}

// ============================================================================
// Store Definition
// ============================================================================

export interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  lastActivity: number;
  twoFactorPending: TwoFactorPendingState | null;
  setUser: (user: User | null) => void;
  updateTokens: (token: string, refreshToken?: string, tokenExpiresAt?: number) => void;
  recordActivity: () => void;
  setTwoFactorPending: (pending: TwoFactorPendingState | null) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,
      lastActivity: Date.now(),
      twoFactorPending: null,
      setUser: (user) => {
        // Notify platform of user change (e.g., theme sync)
        callbacks.onUserSet?.(user);
        set({ user, isAuthenticated: !!user, lastActivity: Date.now() });
      },
      updateTokens: (token, refreshToken, tokenExpiresAt) => {
        const { user } = get();
        if (user) {
          set({
            user: {
              ...user,
              token,
              refreshToken: refreshToken || user.refreshToken,
              tokenExpiresAt: tokenExpiresAt || user.tokenExpiresAt,
            },
            lastActivity: Date.now(),
          });
        }
      },
      recordActivity: () => {
        set({ lastActivity: Date.now() });
      },
      setTwoFactorPending: (pending) => {
        set({ twoFactorPending: pending });
      },
      logout: () => {
        // Get userId before clearing user state
        const { user } = get();
        const userId = user?._id;
        // Notify platform of logout (e.g., clear cookies)
        callbacks.onLogout?.(userId);
        set({ user: null, isAuthenticated: false, lastActivity: 0, twoFactorPending: null });
      },
    }),
    {
      name: 'auth-storage',
    }
  )
);

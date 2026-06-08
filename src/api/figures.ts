/**
 * Figure API Functions
 *
 * All figure-related API calls. These functions require an axios instance
 * created by createApiClient() to be passed in, or they can be bound
 * using createFigureApi().
 */

import { AxiosInstance } from 'axios';
import {
  Figure,
  FigureFormData,
  PaginatedResponse,
  SearchResult,
  StatsData,
  User,
  SystemConfig,
  BulkImportPreviewResponse,
  BulkImportExecuteResponse,
  MfcList,
  MfcListFormData,
  ListPrivacy,
} from '../types';

// ============================================================================
// Auth API
// ============================================================================

export const loginUser = async (
  api: AxiosInstance,
  email: string,
  password: string
): Promise<User | { requiresTwoFactor: true; sessionId: string; methods: string[] }> => {
  const response = await api.post('/auth/login', { email, password });

  // Handle 2FA required response
  if (response.data?.requiresTwoFactor) {
    return {
      requiresTwoFactor: true,
      sessionId: response.data.data.sessionId,
      methods: response.data.data.methods,
    };
  }

  const userData = response.data?.data;

  // Handle missing or malformed response data
  if (!userData) {
    return undefined as any;
  }

  // Map accessToken to token for frontend compatibility
  const tokenExpiresAt = Date.now() + (14 * 60 * 1000);

  return {
    _id: userData._id,
    username: userData.username,
    email: userData.email,
    isAdmin: userData.isAdmin,
    token: userData.accessToken,
    refreshToken: userData.refreshToken,
    tokenExpiresAt,
    emailVerified: userData.emailVerified ?? false,
    twoFactorEnabled: userData.twoFactorEnabled ?? false,
    webauthnCredentialCount: userData.webauthnCredentialCount ?? 0,
  };
};

export const registerUser = async (
  api: AxiosInstance,
  username: string,
  email: string,
  password: string
): Promise<User> => {
  const response = await api.post('/auth/register', { username, email, password });
  const userData = response.data?.data;

  if (!userData) {
    return undefined as any;
  }

  const tokenExpiresAt = Date.now() + (14 * 60 * 1000);

  return {
    _id: userData._id,
    username: userData.username,
    email: userData.email,
    isAdmin: userData.isAdmin,
    token: userData.accessToken,
    refreshToken: userData.refreshToken,
    tokenExpiresAt,
    emailVerified: userData.emailVerified ?? false,
    twoFactorEnabled: userData.twoFactorEnabled ?? false,
    webauthnCredentialCount: userData.webauthnCredentialCount ?? 0,
  };
};

export const refreshAccessToken = async (
  api: AxiosInstance,
  currentRefreshToken: string
): Promise<{
  token: string;
  refreshToken?: string;
  tokenExpiresAt: number;
}> => {
  const response = await api.post('/auth/refresh', { refreshToken: currentRefreshToken });
  const data = response.data.data;

  const tokenExpiresAt = Date.now() + (14 * 60 * 1000);

  return {
    token: data.accessToken || data.token,
    refreshToken: data.refreshToken,
    tokenExpiresAt,
  };
};

export const logoutUser = async (api: AxiosInstance): Promise<void> => {
  await api.post('/auth/logout');
};

export const logoutAllSessions = async (api: AxiosInstance): Promise<void> => {
  await api.post('/auth/logout-all');
};

export const getUserSessions = async (api: AxiosInstance): Promise<any[]> => {
  const response = await api.get('/auth/sessions');
  return response.data.data;
};

export const getUserProfile = async (api: AxiosInstance): Promise<User> => {
  const response = await api.get('/auth/profile');
  return response.data.data;
};

export const updateUserProfile = async (api: AxiosInstance, userData: Partial<User>): Promise<User> => {
  const response = await api.put('/auth/profile', userData);
  return response.data.data;
};

// ============================================================================
// Figures API
// ============================================================================

export const getFigures = async (
  api: AxiosInstance,
  page = 1,
  limit = 10,
  sortBy = 'activity',
  sortOrder: 'asc' | 'desc' = 'asc',
  status?: 'owned' | 'ordered' | 'wished'
): Promise<PaginatedResponse<Figure>> => {
  const params = new URLSearchParams({
    page: page.toString(),
    limit: limit.toString(),
    sortBy,
    sortOrder,
  });
  if (status) {
    params.append('status', status);
  }
  const response = await api.get(`/figures?${params.toString()}`);
  return response.data;
};

export const getFigureById = async (api: AxiosInstance, id: string): Promise<Figure> => {
  const response = await api.get(`/figures/${id}`);
  return response.data.data;
};

export const createFigure = async (api: AxiosInstance, figureData: FigureFormData): Promise<Figure> => {
  const response = await api.post('/figures', figureData);
  return response.data.data;
};

export const updateFigure = async (api: AxiosInstance, id: string, figureData: FigureFormData): Promise<Figure> => {
  const response = await api.put(`/figures/${id}`, figureData);
  return response.data.data;
};

export const deleteFigure = async (api: AxiosInstance, id: string): Promise<void> => {
  await api.delete(`/figures/${id}`);
};

export const searchFigures = async (api: AxiosInstance, query: string): Promise<SearchResult[]> => {
  const response = await api.get(`/figures/search?query=${encodeURIComponent(query)}`);
  return response.data.data;
};

export const filterFigures = async (
  api: AxiosInstance,
  params: {
    manufacturer?: string;
    distributor?: string;
    scale?: string;
    origin?: string;
    category?: string;
    page?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
    status?: 'owned' | 'ordered' | 'wished';
  }
): Promise<PaginatedResponse<Figure>> => {
  const queryString = Object.entries(params)
    .filter(([_, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&');

  const response = await api.get(`/figures/filter?${queryString}`);
  return response.data;
};

export const getFigureStats = async (
  api: AxiosInstance,
  status?: 'owned' | 'ordered' | 'wished'
): Promise<StatsData> => {
  const params = status ? { status } : {};
  const response = await api.get('/figures/stats', { params });
  return response.data.data;
};

// ============================================================================
// Public Config API (no auth required)
// ============================================================================

export const getPublicConfig = async (api: AxiosInstance, key: string): Promise<SystemConfig | null> => {
  try {
    const response = await api.get(`/config/${key}`);
    return response.data.data;
  } catch {
    return null;
  }
};

// ============================================================================
// Bulk Import API
// ============================================================================

export const previewBulkImport = async (api: AxiosInstance, csvContent: string): Promise<BulkImportPreviewResponse> => {
  const response = await api.post('/figures/bulk-import/preview', { csvContent });
  return response.data;
};

export const executeBulkImport = async (
  api: AxiosInstance,
  csvContent: string,
  skipDuplicates = true
): Promise<BulkImportExecuteResponse> => {
  const response = await api.post('/figures/bulk-import', { csvContent, skipDuplicates });
  return response.data;
};

// ============================================================================
// Lists API
// ============================================================================

export const getLists = async (
  api: AxiosInstance,
  params?: {
    page?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
    privacy?: ListPrivacy;
  }
): Promise<PaginatedResponse<MfcList>> => {
  const queryParams = new URLSearchParams();
  if (params?.page) queryParams.set('page', params.page.toString());
  if (params?.limit) queryParams.set('limit', params.limit.toString());
  if (params?.sortBy) queryParams.set('sortBy', params.sortBy);
  if (params?.sortOrder) queryParams.set('sortOrder', params.sortOrder);
  if (params?.privacy) queryParams.set('privacy', params.privacy);

  const query = queryParams.toString();
  const response = await api.get(`/lists${query ? `?${query}` : ''}`);
  return response.data;
};

export const getListById = async (api: AxiosInstance, id: string): Promise<MfcList> => {
  const response = await api.get(`/lists/${id}`);
  return response.data.data;
};

export const createList = async (api: AxiosInstance, data: MfcListFormData): Promise<MfcList> => {
  const response = await api.post('/lists', data);
  return response.data.data;
};

export const updateList = async (api: AxiosInstance, id: string, data: Partial<MfcListFormData>): Promise<MfcList> => {
  const response = await api.put(`/lists/${id}`, data);
  return response.data.data;
};

export const deleteList = async (api: AxiosInstance, id: string): Promise<void> => {
  await api.delete(`/lists/${id}`);
};

export const getListsByItem = async (api: AxiosInstance, mfcId: number): Promise<{ _id: string; name: string }[]> => {
  const response = await api.get(`/lists/by-item/${mfcId}`);
  return response.data.data;
};

export const addItemsToList = async (api: AxiosInstance, listId: string, mfcIds: number[]): Promise<MfcList> => {
  const response = await api.post(`/lists/${listId}/items`, { mfcIds });
  return response.data.data;
};

export const removeItemsFromList = async (api: AxiosInstance, listId: string, mfcIds: number[]): Promise<MfcList> => {
  const response = await api.delete(`/lists/${listId}/items`, { data: { mfcIds } });
  return response.data.data;
};

export const syncLists = async (api: AxiosInstance, lists: MfcListFormData[]): Promise<{ upserted: number }> => {
  const response = await api.post('/lists/sync', { lists });
  return response.data.data;
};

// ============================================================================
// Email Verification
// ============================================================================

export const verifyEmailToken = async (api: AxiosInstance, token: string, userId: string) => {
  const { data } = await api.post('/auth/verify-email', { token, userId });
  return data;
};

export const resendVerificationEmail = async (api: AxiosInstance, email: string) => {
  const { data } = await api.post('/auth/resend-verification', { email });
  return data;
};

export const forgotPasswordRequest = async (api: AxiosInstance, email: string) => {
  const { data } = await api.post('/auth/forgot-password', { email });
  return data;
};

export const resetPasswordRequest = async (api: AxiosInstance, token: string, password: string, userId: string) => {
  const { data } = await api.post('/auth/reset-password', { token, password, userId });
  return data;
};

// ============================================================================
// Two-Factor
// ============================================================================

export const verify2FA = async (api: AxiosInstance, sessionId: string, method: string, code: string) => {
  const { data } = await api.post('/auth/2fa/verify', { sessionId, method, code });
  return data;
};

export const setupTOTP = async (api: AxiosInstance) => {
  const { data } = await api.post('/auth/2fa/totp/setup');
  return data;
};

export const verifyTOTPSetup = async (api: AxiosInstance, code: string) => {
  const { data } = await api.post('/auth/2fa/totp/verify-setup', { code });
  return data;
};

export const disableTOTP = async (api: AxiosInstance, code: string) => {
  const { data } = await api.delete('/auth/2fa/totp', { data: { code } });
  return data;
};

export const regenerateBackupCodes = async (api: AxiosInstance, code: string) => {
  const { data } = await api.post('/auth/2fa/backup-codes', { code });
  return data;
};

// ============================================================================
// WebAuthn
// ============================================================================

export const getWebAuthnRegisterOptions = async (api: AxiosInstance, nickname?: string) => {
  const { data } = await api.post('/auth/webauthn/register/options', { nickname });
  return data;
};

export const verifyWebAuthnRegistration = async (api: AxiosInstance, challengeId: string, response: any) => {
  const { data } = await api.post('/auth/webauthn/register/verify', { challengeId, response });
  return data;
};

export const getWebAuthnLoginOptions = async (api: AxiosInstance, email?: string) => {
  const { data } = await api.post('/auth/webauthn/login/options', { email });
  return data;
};

export const verifyWebAuthnLogin = async (api: AxiosInstance, challengeId: string, response: any) => {
  const { data } = await api.post('/auth/webauthn/login/verify', { challengeId, response });
  return data;
};

export const deleteWebAuthnCredential = async (api: AxiosInstance, credentialId: string) => {
  const { data } = await api.delete(`/auth/webauthn/credential/${credentialId}`);
  return data;
};

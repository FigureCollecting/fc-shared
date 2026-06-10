import { useAuthStore, configureAuthStore } from '../../src/stores/auth';
import { User } from '../../src/types';

const sampleUser: User = {
  _id: 'u1',
  username: 'ross',
  email: 'r@example.com',
  isAdmin: false,
  token: 'tok',
  refreshToken: 'ref',
};

describe('useAuthStore', () => {
  beforeEach(() => {
    configureAuthStore({});
    useAuthStore.getState().logout();
  });

  it('setUser sets the user and the authenticated flag', () => {
    useAuthStore.getState().setUser(sampleUser);
    const s = useAuthStore.getState();
    expect(s.user).toEqual(sampleUser);
    expect(s.isAuthenticated).toBe(true);
  });

  it('setUser(null) clears authentication', () => {
    useAuthStore.getState().setUser(sampleUser);
    useAuthStore.getState().setUser(null);
    const s = useAuthStore.getState();
    expect(s.user).toBeNull();
    expect(s.isAuthenticated).toBe(false);
  });

  it('setUser fires the onUserSet callback', () => {
    const onUserSet = jest.fn();
    configureAuthStore({ onUserSet });
    useAuthStore.getState().setUser(sampleUser);
    expect(onUserSet).toHaveBeenCalledWith(sampleUser);
  });

  it('updateTokens merges new tokens into the existing user', () => {
    useAuthStore.getState().setUser(sampleUser);
    useAuthStore.getState().updateTokens('newtok', 'newref', 12345);
    const u = useAuthStore.getState().user;
    expect(u?.token).toBe('newtok');
    expect(u?.refreshToken).toBe('newref');
    expect(u?.tokenExpiresAt).toBe(12345);
  });

  it('updateTokens keeps the prior refresh token when none is given', () => {
    useAuthStore.getState().setUser(sampleUser);
    useAuthStore.getState().updateTokens('newtok');
    const u = useAuthStore.getState().user;
    expect(u?.token).toBe('newtok');
    expect(u?.refreshToken).toBe('ref');
  });

  it('updateTokens is a no-op when there is no user', () => {
    useAuthStore.getState().setUser(null);
    useAuthStore.getState().updateTokens('x');
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('recordActivity advances lastActivity', () => {
    useAuthStore.setState({ lastActivity: 0 });
    useAuthStore.getState().recordActivity();
    expect(useAuthStore.getState().lastActivity).toBeGreaterThan(0);
  });

  it('setTwoFactorPending stores the pending state', () => {
    const pending = { sessionId: 's1', methods: ['totp'] };
    useAuthStore.getState().setTwoFactorPending(pending);
    expect(useAuthStore.getState().twoFactorPending).toEqual(pending);
  });

  it('logout clears state and fires onLogout with the userId', () => {
    const onLogout = jest.fn();
    useAuthStore.getState().setUser(sampleUser);
    configureAuthStore({ onLogout });
    useAuthStore.getState().logout();
    const s = useAuthStore.getState();
    expect(onLogout).toHaveBeenCalledWith('u1');
    expect(s.user).toBeNull();
    expect(s.isAuthenticated).toBe(false);
    expect(s.twoFactorPending).toBeNull();
  });
});

// AuthContext.tsx — 로그인 상태(loading/anon/authed) 관리 + 세션 만료 공통 처리.
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { fetchMe, logout as apiLogout, deleteAccount as apiDeleteAccount } from '../api/auth';
import type { Me } from '../types';

type AuthState = { status: 'loading' } | { status: 'anon' } | { status: 'authed'; me: Me };

interface AuthContextValue {
  status: AuthState['status'];
  me: Me | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  deleteAccount: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    try {
      const me = await fetchMe();
      setState({ status: 'authed', me });
    } catch {
      // 401 및 그 외 오류(네트워크 등) 모두 비로그인으로 취급.
      setState({ status: 'anon' });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 어느 화면에서든 세션이 만료되면(client.ts 가 401 발생 시 dispatch) 즉시 anon 전환 → 라우트 가드가 /login 으로 보낸다.
  useEffect(() => {
    const onUnauthorized = () => setState({ status: 'anon' });
    window.addEventListener('auth:unauthorized', onUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', onUnauthorized);
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      setState({ status: 'anon' });
    }
  }, []);

  const deleteAccount = useCallback(async () => {
    try {
      await apiDeleteAccount();
    } finally {
      setState({ status: 'anon' });
    }
  }, []);

  const value: AuthContextValue = {
    status: state.status,
    me: state.status === 'authed' ? state.me : null,
    refresh,
    logout,
    deleteAccount,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 는 AuthProvider 내부에서만 사용할 수 있습니다.');
  return ctx;
}

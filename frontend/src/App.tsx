import { Routes, Route, Navigate } from 'react-router-dom';
import TopNav from './components/TopNav';
import DashboardPage from './pages/DashboardPage';
import QueriesPage from './pages/QueriesPage';
import ReposPage from './pages/ReposPage';
import RepoDetailPage from './pages/RepoDetailPage';
import LoginPage from './pages/LoginPage';
import { useAuth } from './auth/AuthContext';
import { LoadingState } from './components/States';

export default function App() {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <div className="app-shell">
        <main className="container">
          <LoadingState label="인증 확인 중…" />
        </main>
      </div>
    );
  }

  if (status === 'anon') {
    return (
      <div className="app-shell">
        <main className="container">
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <TopNav />
      <main className="container">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/queries" element={<QueriesPage />} />
          <Route path="/repos" element={<ReposPage />} />
          <Route path="/repos/:id" element={<RepoDetailPage />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

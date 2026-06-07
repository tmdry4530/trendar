import { Routes, Route, Navigate } from 'react-router-dom';
import TopNav from './components/TopNav';
import DashboardPage from './pages/DashboardPage';
import QueriesPage from './pages/QueriesPage';
import ReposPage from './pages/ReposPage';
import RepoDetailPage from './pages/RepoDetailPage';

export default function App() {
  return (
    <div className="app-shell">
      <TopNav />
      <main className="container">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/queries" element={<QueriesPage />} />
          <Route path="/repos" element={<ReposPage />} />
          <Route path="/repos/:id" element={<RepoDetailPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

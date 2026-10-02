import { useState, Suspense } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { Inbox, MessageCircle, RefreshCcw, Users } from 'lucide-react';
import ErrorBoundary from '@/components/ErrorBoundary';
import RouteFallback from '@/components/RouteFallback';
import { useAuth } from '@/hooks/useAuth';
import Sidebar from '@/components/layout/Sidebar';
import TopBar from '@/components/layout/TopBar';
import { resolveNavigation } from '@/lib/navigation';

const MOBILE_SHORTCUTS = [
  { label: 'Hoje', to: '/hoje', icon: Inbox, selected: state => state.areaId === 'today' },
  { label: 'Pessoas', to: '/pessoas', icon: Users, selected: state => state.areaId === 'people' },
  { label: 'Contatos', to: '/comunicacao', icon: MessageCircle, selected: state => state.areaId === 'communication' },
  { label: 'Renovações', to: '/assessoria/renovacoes', icon: RefreshCcw, selected: state => state.itemId === 'renewals' },
];

export default function AdminLayout({ children }) {
  const { user, loading, signOut } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();
  const navigation = resolveNavigation(location.pathname);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;

  return (
    <div className="flex h-screen bg-gray-50">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} onSignOut={signOut} />
      <div className="flex-1 flex flex-col min-w-0 lg:ml-64">
        <TopBar onMenuClick={() => setSidebarOpen(true)} />
        <main className="flex-1 overflow-y-auto p-4 pb-24 lg:p-6">
          <ErrorBoundary routeKey={location.pathname}>
            <Suspense fallback={<RouteFallback />}>
              {children}
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
      <nav aria-label="Acessos rápidos" className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t bg-white px-1 pt-1 shadow-lg lg:hidden" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        {MOBILE_SHORTCUTS.map(shortcut => {
          const Icon = shortcut.icon;
          const selected = shortcut.selected(navigation);
          return (
            <Link key={shortcut.to} to={shortcut.to} aria-current={selected ? 'page' : undefined}
              className={`flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-lg text-[11px] font-medium ${selected ? 'bg-blue-50 text-blue-700' : 'text-slate-600'}`}>
              <Icon className="h-4 w-4" />
              {shortcut.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

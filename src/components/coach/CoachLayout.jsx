import { Suspense } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { KeyRound, LogOut } from 'lucide-react';
import ErrorBoundary from '@/components/ErrorBoundary';
import RouteFallback from '@/components/RouteFallback';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { homePathForRole, mustChangePassword } from '@/lib/auth-role';

// Casca da área do coach. Só entra conta de coach (a API confirma no servidor); quem é
// administrador volta para o painel. Enquanto a senha provisória não for trocada, só a
// tela de trocar senha abre.
export default function CoachLayout({ children }) {
  const { user, role, coach, loading, signOut } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (role !== 'coach') return <Navigate to={homePathForRole(role)} replace />;
  const forced = mustChangePassword(user);
  if (forced && location.pathname !== '/coach/senha') return <Navigate to="/coach/senha" replace />;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <Link to="/coach" className="min-w-0">
            <p className="text-sm font-bold text-gray-900">Endurance ON · Coach</p>
            {coach?.name && <p className="truncate text-xs text-muted-foreground">{coach.name}</p>}
          </Link>
          <div className="flex shrink-0 items-center gap-1">
            {!forced && (
              <Button asChild variant="ghost" size="sm">
                <Link to="/coach/senha"><KeyRound className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Trocar senha</Link>
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => signOut()}>
              <LogOut className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Sair
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-3xl p-4 sm:p-6">
        <ErrorBoundary routeKey={location.pathname}>
          <Suspense fallback={<RouteFallback />}>
            {children}
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  );
}

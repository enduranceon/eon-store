import { Suspense, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Navigate, useLocation } from 'react-router-dom';
import { Activity, CalendarDays, ChevronDown, Home, KeyRound, LogOut, TrendingUp, Users } from 'lucide-react';
import ErrorBoundary from '@/components/ErrorBoundary';
import RouteFallback from '@/components/RouteFallback';
import { Avatar } from '@/components/coach/kit';
import { useAuth } from '@/hooks/useAuth';
import { homePathForRole, mustChangePassword } from '@/lib/auth-role';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/coach', label: 'Início', icon: Home, end: true },
  { to: '/coach/alunos', label: 'Alunos', icon: Users },
  { to: '/coach/movimento', label: 'Evolução', icon: TrendingUp },
  { to: '/coach/eventos', label: 'Eventos', icon: CalendarDays },
];

function titleFor(pathname) {
  if (pathname.startsWith('/coach/senha')) return 'Senha';
  const item = NAV.find(entry => (entry.end ? pathname === entry.to : pathname.startsWith(entry.to)));
  return item ? item.label : 'Coach';
}

function Brand({ compact = false }) {
  return (
    <Link to="/coach" className="flex min-w-0 items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-sm">
        <Activity className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-sm font-bold text-white">Endurance ON</span>
        {!compact && <span className="block truncate text-[11px] font-medium text-slate-400">Área do coach</span>}
      </span>
    </Link>
  );
}

// Menu da conta no celular: nome, trocar senha e sair. Fecha ao tocar fora, no Esc ou ao
// trocar de tela.
function AccountMenu({ name, onSignOut }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const location = useLocation();

  useEffect(() => { setOpen(false); }, [location.pathname]);
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = event => { if (box.current && !box.current.contains(event.target)) setOpen(false); };
    const onKey = event => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Menu da conta"
        className="flex items-center gap-1.5 rounded-full p-0.5 pr-1.5 text-slate-300 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        <Avatar name={name || 'Coach'} size="sm" />
        <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-40 mt-2 w-60 overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-800 shadow-xl">
          <div className="border-b bg-slate-50 px-4 py-3">
            <p className="truncate text-sm font-semibold text-slate-900">{name || 'Coach'}</p>
            <p className="text-xs text-slate-500">Conta de coach</p>
          </div>
          <Link role="menuitem" to="/coach/senha" className="flex min-h-12 items-center gap-3 px-4 text-sm hover:bg-slate-50">
            <KeyRound className="h-4 w-4 text-slate-500" aria-hidden="true" /> Trocar senha
          </Link>
          <button type="button" role="menuitem" onClick={onSignOut} className="flex min-h-12 w-full items-center gap-3 border-t px-4 text-left text-sm text-red-700 hover:bg-red-50">
            <LogOut className="h-4 w-4" aria-hidden="true" /> Sair
          </button>
        </div>
      )}
    </div>
  );
}

function SideNavLink({ item }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) => cn(
        'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        isActive ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-300 hover:bg-white/10 hover:text-white',
      )}
    >
      <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
      {item.label}
    </NavLink>
  );
}

function TabLink({ item }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) => cn(
        'flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600',
        isActive ? 'text-blue-700' : 'text-slate-500 hover:text-slate-800',
      )}
    >
      {({ isActive }) => (
        <>
          <span className={cn('inline-flex h-7 w-12 items-center justify-center rounded-full transition-colors', isActive && 'bg-blue-50')}>
            <Icon className="h-5 w-5" aria-hidden="true" />
          </span>
          {item.label}
        </>
      )}
    </NavLink>
  );
}

// Casca da área do coach. Só entra conta de coach (a API confirma no servidor); quem é
// administrador volta para o painel. Enquanto a senha provisória não for trocada, só a
// tela de trocar senha abre.
export default function CoachLayout({ children }) {
  const { user, role, coach, loading, signOut } = useAuth();
  const location = useLocation();
  const forced = mustChangePassword(user);
  const ready = !loading && Boolean(user) && role === 'coach';

  useEffect(() => {
    if (ready) document.title = `${titleFor(location.pathname)} · Coach · Endurance ON`;
  }, [ready, location.pathname]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (role !== 'coach') return <Navigate to={homePathForRole(role)} replace />;
  if (forced && location.pathname !== '/coach/senha') return <Navigate to="/coach/senha" replace />;

  const name = coach?.name || '';

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {!forced && (
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col bg-[#1a1a2e] p-4 lg:flex">
          <div className="px-1 pb-6 pt-2"><Brand /></div>
          <nav aria-label="Áreas do coach" className="flex-1 space-y-1">
            {NAV.map(item => <SideNavLink key={item.to} item={item} />)}
          </nav>
          <div className="space-y-1 border-t border-white/10 pt-4">
            <div className="flex items-center gap-3 px-2 pb-3">
              <Avatar name={name || 'Coach'} />
              <div className="min-w-0 leading-tight">
                <p className="truncate text-sm font-semibold text-white">{name || 'Coach'}</p>
                <p className="text-[11px] text-slate-400">Conta de coach</p>
              </div>
            </div>
            <Link to="/coach/senha" className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm text-slate-300 hover:bg-white/10 hover:text-white">
              <KeyRound className="h-4 w-4" aria-hidden="true" /> Trocar senha
            </Link>
            <button type="button" onClick={() => signOut()} className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-slate-300 hover:bg-white/10 hover:text-white">
              <LogOut className="h-4 w-4" aria-hidden="true" /> Sair
            </button>
          </div>
        </aside>
      )}

      <header className={cn('sticky top-0 z-30 bg-[#1a1a2e] shadow-sm', !forced && 'lg:hidden')}>
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-4">
          <Brand compact />
          {forced
            ? <button type="button" onClick={() => signOut()} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-slate-300 hover:bg-white/10"><LogOut className="h-4 w-4" aria-hidden="true" /> Sair</button>
            : <AccountMenu name={name} onSignOut={() => signOut()} />}
        </div>
      </header>

      <div className={cn(!forced && 'lg:pl-64')}>
        <main className={cn('mx-auto w-full max-w-5xl px-4 py-5 sm:px-6 lg:py-8', !forced && 'pb-28 lg:pb-10')}>
          <ErrorBoundary routeKey={location.pathname}>
            <Suspense fallback={<RouteFallback />}>
              <div key={location.pathname} className="coach-enter">{children}</div>
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>

      {!forced && (
        <nav aria-label="Áreas do coach" className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
          <div className="mx-auto flex max-w-md">
            {NAV.map(item => <TabLink key={item.to} item={item} />)}
          </div>
        </nav>
      )}
    </div>
  );
}

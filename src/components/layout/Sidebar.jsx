import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Package, ShoppingCart, Users, BarChart3,
  Megaphone, Store, X, Truck, Tag, UserCheck, LogOut, Archive,
  ClipboardList, ChevronDown, ChevronRight, Settings, TrendingUp,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/api/db';

const PRESALE_ITEMS = [
  { label: 'Dashboard',   icon: LayoutDashboard, to: '/admin',     exact: true },
  { label: 'Campanhas',   icon: Megaphone,        to: '/campanhas' },
  { label: 'Pedidos',     icon: ShoppingCart,     to: '/pedidos',  badge: 'orders' },
  { label: 'Clientes',    icon: Users,            to: '/clientes', badge: 'clients' },
];

const LOJA_ITEMS = [
  { label: 'Estoque',      icon: Archive,       to: '/estoque',          exact: true },
  { label: 'Pedidos Loja', icon: ClipboardList, to: '/estoque/pedidos' },
];

const CONFIG_ITEMS = [
  { label: 'Produtos',     icon: Package,   to: '/produtos' },
  { label: 'Categorias',   icon: Tag,       to: '/categorias' },
  { label: 'Treinadores',  icon: UserCheck, to: '/treinadores' },
  { label: 'Fornecedores', icon: Truck,     to: '/fornecedores' },
];

function NavItem({ item, isActive, badges, onClick }) {
  const Icon = item.icon;
  const active = isActive(item.to, item.exact);
  const badgeCount = item.badge ? (badges[item.badge] || 0) : 0;

  return (
    <NavLink
      to={item.to}
      onClick={onClick}
      className={cn(
        'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium mb-1 transition-colors',
        active ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-800 hover:text-white'
      )}
    >
      <Icon className="w-4 h-4 shrink-0" />
      <span className="flex-1">{item.label}</span>
      {badgeCount > 0 && (
        <span className={cn(
          'text-xs font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center',
          active ? 'bg-white/20 text-white' : 'bg-red-500 text-white'
        )}>
          {badgeCount}
        </span>
      )}
    </NavLink>
  );
}

function SectionLabel({ label }) {
  return (
    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 px-3 pt-4 pb-1">
      {label}
    </p>
  );
}

export default function Sidebar({ open, onClose, onSignOut }) {
  const location = useLocation();
  const [configOpen, setConfigOpen] = useState(false);
  const [badges, setBadges] = useState({ orders: 0, clients: 0 });

  const isActive = (to, exact) => {
    if (exact) return location.pathname === to;
    return location.pathname.startsWith(to);
  };

  // Abre Cadastros automaticamente se estiver numa rota de config
  useEffect(() => {
    const configRoutes = CONFIG_ITEMS.map(i => i.to);
    if (configRoutes.some(r => location.pathname.startsWith(r))) {
      setConfigOpen(true);
    }
  }, [location.pathname]);

  // Busca contagens de alertas
  useEffect(() => {
    const fetchAlerts = async () => {
      try {
        const [ordersRes, clientsRes] = await Promise.all([
          supabase
            .from('presale_orders')
            .select('id', { count: 'exact', head: true })
            .in('payment_status', ['awaiting_charge', 'message_sent']),
          supabase
            .from('presale_customers')
            .select('id', { count: 'exact', head: true })
            .or('cpf.is.null,cpf.eq.""'),
        ]);
        setBadges({
          orders: ordersRes.count || 0,
          clients: clientsRes.count || 0,
        });
      } catch { /* silencioso */ }
    };
    fetchAlerts();
  }, []);

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={onClose} />
      )}

      <aside className={cn(
        'fixed left-0 top-0 z-40 h-full w-64 bg-slate-900 text-white flex flex-col transition-transform duration-200',
        open ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
      )}>
        {/* Logo */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-700">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center">
              <Store className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-lg tracking-tight">EON Store</span>
          </div>
          <button onClick={onClose} className="lg:hidden text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-2 px-3">
          {/* Pré-venda */}
          <SectionLabel label="Pré-venda" />
          {PRESALE_ITEMS.map(item => (
            <NavItem key={item.to} item={item} isActive={isActive} badges={badges} onClick={onClose} />
          ))}

          {/* Loja */}
          <SectionLabel label="Loja" />
          {LOJA_ITEMS.map(item => (
            <NavItem key={item.to} item={item} isActive={isActive} badges={badges} onClick={onClose} />
          ))}

          {/* Análises */}
          <SectionLabel label="Análises" />
          <NavItem
            item={{ label: 'Fluxo de Caixa', icon: TrendingUp, to: '/financeiro' }}
            isActive={isActive}
            badges={badges}
            onClick={onClose}
          />
          <NavItem
            item={{ label: 'Relatórios', icon: BarChart3, to: '/relatorios' }}
            isActive={isActive}
            badges={badges}
            onClick={onClose}
          />

          {/* Cadastros — colapsável */}
          <div className="mt-3">
            <button
              onClick={() => setConfigOpen(o => !o)}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-widest text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors"
            >
              <Settings className="w-3.5 h-3.5" />
              <span className="flex-1 text-left">Cadastros</span>
              {configOpen
                ? <ChevronDown className="w-3.5 h-3.5" />
                : <ChevronRight className="w-3.5 h-3.5" />
              }
            </button>
            {configOpen && (
              <div className="mt-1">
                {CONFIG_ITEMS.map(item => (
                  <NavItem key={item.to} item={item} isActive={isActive} badges={badges} onClick={onClose} />
                ))}
              </div>
            )}
          </div>
        </nav>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-700 space-y-3">
          {onSignOut && (
            <button
              onClick={onSignOut}
              className="flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors w-full"
            >
              <LogOut className="w-4 h-4" /> Sair
            </button>
          )}
          <p className="text-xs text-slate-500">EON Store v1.0</p>
        </div>
      </aside>
    </>
  );
}

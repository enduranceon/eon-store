import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Activity, FileText, Layers, CalendarClock, Award, DollarSign,
  Users, BarChart3, TrendingUp,
  ShoppingCart, Megaphone, Undo2, Archive, ClipboardList,
  LayoutDashboard, Package, Tag, UserCheck, Truck, Ticket, Palette, Settings,
  ChevronDown, ChevronRight, X, LogOut, Inbox, AlertCircle, Zap, RefreshCcw,
} from 'lucide-react';
import { cn, todayLocalStr } from '@/lib/utils';
import { supabase } from '@/api/db';
import { isEffectiveOpenSale } from '@/lib/sales';

// ─────────────────────────────────────────────────────────────────
// ITENS DE NAVEGAÇÃO
// ─────────────────────────────────────────────────────────────────

const TODAY_ITEM = { label: 'Hoje', icon: Inbox, to: '/hoje', exact: true, badge: 'today' };
// ASSESSORIA — core do negócio
const ASSESSORIA_ITEMS = [
  { label: 'Painel',         icon: Activity,      to: '/assessoria',              exact: true },
  { label: 'Contratos',      icon: FileText,      to: '/assessoria/contratos',    badge: 'assessoria' },
  { label: 'Renovações',     icon: RefreshCcw,    to: '/assessoria/renovacoes',   badge: 'renewals' },
  { label: 'Alunos',         icon: Users,         to: '/assessoria/alunos' },
  { label: 'Planos',         icon: Layers,        to: '/assessoria/planos' },
  { label: 'Coaches',        icon: Award,         to: '/assessoria/coaches' },
  { label: 'Fechamento',     icon: DollarSign,    to: '/assessoria/fechamento' },
  { label: 'Régua',          icon: CalendarClock, to: '/assessoria/regua' },
];

// FINANCEIRO — visão unificada
const FINANCEIRO_ITEMS = [
  { label: 'Vendas em aberto', icon: AlertCircle, to: '/financeiro', exact: true, badge: 'openSales' },
  { label: 'Fluxo de caixa', icon: TrendingUp,    to: '/financeiro/fluxo-caixa' },
  { label: 'Relatórios',     icon: BarChart3,     to: '/relatorios' },
  { label: 'Clientes',       icon: Users,         to: '/clientes',   badge: 'clients' },
];

// LOJA — módulo secundário (colapsável)
const LOJA_ITEMS = [
  { label: 'Pedidos',        icon: ShoppingCart,  to: '/pedidos',         badge: 'orders' },
  { label: 'Campanhas',      icon: Megaphone,     to: '/campanhas' },
  { label: 'Devoluções',     icon: Undo2,         to: '/devolucoes' },
  { label: 'Estoque',        icon: Archive,       to: '/estoque',         exact: true },
  { label: 'Ped. estoque',   icon: ClipboardList, to: '/estoque/pedidos' },
];

// CONFIGURAÇÕES (colapsável)
const CONFIG_ITEMS = [
  { label: 'Dashboard',         icon: LayoutDashboard, to: '/admin',                  exact: true },
  { label: 'Produtos loja',     icon: Package,         to: '/produtos' },
  { label: 'Categorias',        icon: Tag,             to: '/categorias' },
  { label: 'Treinadores',       icon: UserCheck,       to: '/treinadores' },
  { label: 'Fornecedores',      icon: Truck,           to: '/fornecedores' },
  { label: 'Cupons',            icon: Ticket,          to: '/cupons' },
  { label: 'Centros receita',   icon: Palette,         to: '/centros-receita' },
  { label: 'Métodos pagamento', icon: DollarSign,      to: '/configuracoes/pagamento' },
  { label: 'Config. assessoria',icon: Settings,        to: '/assessoria/configuracoes' },
  { label: 'Saúde do sistema',  icon: Activity,        to: '/admin/saude' },
];

// ─────────────────────────────────────────────────────────────────
// COMPONENTES
// ─────────────────────────────────────────────────────────────────

function NavItem({ item, isActive, badges, onClick }) {
  const Icon = item.icon;
  const active = isActive(item.to, item.exact);
  const badgeCount = item.badge ? (badges[item.badge] || 0) : 0;

  return (
    <NavLink
      to={item.to}
      onClick={onClick}
      className={cn(
        'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium mb-0.5 transition-colors',
        active
          ? 'bg-blue-600 text-white'
          : 'text-slate-400 hover:bg-slate-800 hover:text-white'
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

function CollapseSection({ label, icon: Icon, items, isActive, badges, onClick, defaultOpen = false }) {
  const location = useLocation();
  const isInGroup = items.some(item =>
    item.exact ? location.pathname === item.to : location.pathname.startsWith(item.to)
  );
  const [manuallyOpen, setManuallyOpen] = useState(defaultOpen);
  const open = manuallyOpen || isInGroup;

  return (
    <div className="mt-1">
      <button
        onClick={() => setManuallyOpen(o => !o)}
        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-widest text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors"
      >
        <Icon className="w-3.5 h-3.5 shrink-0" />
        <span className="flex-1 text-left">{label}</span>
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
      </button>
      {open && (
        <div className="mt-0.5 ml-2 pl-2 border-l border-slate-700/60">
          {items.map(item => (
            <NavItem key={item.to} item={item} isActive={isActive} badges={badges} onClick={onClick} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// SIDEBAR PRINCIPAL
// ─────────────────────────────────────────────────────────────────

export default function Sidebar({ open, onClose, onSignOut }) {
  const location = useLocation();
  const [badges, setBadges] = useState({ orders: 0, clients: 0, today: 0, assessoria: 0, renewals: 0, openSales: 0 });

  const isActive = (to, exact) => {
    if (exact) return location.pathname === to;
    if (to === '/clientes' && location.pathname.startsWith('/assessoria/alunos')) return true;
    return location.pathname.startsWith(to);
  };

  // Contagens de alertas
  useEffect(() => {
    const fetchAlerts = async () => {
      try {
        const todayStr = todayLocalStr();
        const in14 = new Date(); in14.setDate(in14.getDate() + 14);
        const in14Str = in14.toISOString().split('T')[0];

        const [presaleOrders, stockOrders, returnsRes, clientsRes, contractsOverdue, contractsExpiring, pendingRefunds, renewalDrafts, contractsOpenPayments] = await Promise.all([
          supabase.from('presale_orders').select('id, payment_status, due_date, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, payment_message_sent_at')
            .neq('payment_status', 'cancelled').neq('payment_status', 'refunded'),
          supabase.from('stock_orders').select('id, payment_status, due_date, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, payment_message_sent_at')
            .neq('payment_status', 'cancelled').neq('payment_status', 'refunded'),
          supabase.from('order_returns').select('id', { count: 'exact', head: true })
            .in('status', ['pending_return', 'received']),
          supabase.from('presale_customers').select('id', { count: 'exact', head: true })
            .or('cpf.is.null,cpf.eq.""'),
          supabase.from('assessment_contracts').select('id', { count: 'exact', head: true })
            .eq('status', 'overdue'),
          supabase.from('assessment_contracts').select('id', { count: 'exact', head: true })
            .eq('status', 'active').lte('end_date', in14Str).gte('end_date', todayStr),
          supabase.from('assessment_contracts').select('id', { count: 'exact', head: true })
            .eq('refund_status', 'pending'),
          supabase.from('assessment_contracts').select('id', { count: 'exact', head: true })
            .eq('status', 'draft'),
          supabase.from('assessment_contracts')
            .select('id, payment_status, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, payment_message_sent_at')
            .neq('status', 'cancelled').neq('status', 'draft')
            .neq('payment_status', 'paid').neq('payment_status', 'refunded'),
        ]);

        const allOrders = [...(presaleOrders.data || []), ...(stockOrders.data || [])];
        const openSalesCount =
          allOrders.filter(isEffectiveOpenSale).length +
          (contractsOpenPayments.data || []).filter(isEffectiveOpenSale).length;
        const todayCount =
          allOrders.filter(o => ['awaiting_charge'].includes(o.payment_status)).length +
          allOrders.filter(o => o.due_date && o.due_date < todayStr && isEffectiveOpenSale(o)).length +
          (returnsRes.count || 0) +
          (pendingRefunds.count || 0);

        setBadges({
          orders:     allOrders.filter(o => ['awaiting_charge'].includes(o.payment_status)).length,
          clients:    clientsRes.count || 0,
          today:      todayCount,
          assessoria: (contractsOverdue.count || 0) + (contractsExpiring.count || 0),
          renewals:   renewalDrafts.count || 0,
          openSales:  openSalesCount,
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

        {/* ── Logo / Marca ──────────────────────────────────── */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700/60">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center shrink-0">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <div>
              <p className="font-bold text-white leading-none text-base tracking-tight">Endurance ON</p>
              <p className="text-[10px] text-slate-400 leading-none mt-0.5">Gestão & Assessoria</p>
            </div>
          </div>
          <button onClick={onClose} className="lg:hidden text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ── Navegação ─────────────────────────────────────── */}
        <nav className="flex-1 overflow-y-auto py-2 px-3">

          {/* Hoje */}
          <div className="pt-1 pb-1">
            <NavItem item={TODAY_ITEM} isActive={isActive} badges={badges} onClick={onClose} />
          </div>

          {/* ── ASSESSORIA — seção principal ──────────────── */}
          <SectionLabel label="Assessoria" />
          {ASSESSORIA_ITEMS.map(item => (
            <NavItem key={item.to} item={item} isActive={isActive} badges={badges} onClick={onClose} />
          ))}
          {badges.assessoria > 0 && (
            <div className="mx-1 mb-1 flex items-center gap-1.5 text-xs text-amber-400 bg-amber-400/10 rounded-lg px-2.5 py-1.5 mt-0.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span>{badges.assessoria} contrato{badges.assessoria !== 1 ? 's' : ''} exige atenção</span>
            </div>
          )}

          {/* ── FINANCEIRO ────────────────────────────────── */}
          <SectionLabel label="Financeiro" />
          {FINANCEIRO_ITEMS.map(item => (
            <NavItem key={item.to} item={item} isActive={isActive} badges={badges} onClick={onClose} />
          ))}

          {/* ── LOJA — colapsável ──────────────────────────── */}
          <div className="mt-3 border-t border-slate-700/40 pt-2">
            <CollapseSection
              label="Loja"
              icon={ShoppingCart}
              items={LOJA_ITEMS}
              isActive={isActive}
              badges={badges}
              onClick={onClose}
            />
          </div>

          {/* ── CONFIGURAÇÕES — colapsável ─────────────────── */}
          <CollapseSection
            label="Configurações"
            icon={Settings}
            items={CONFIG_ITEMS}
            isActive={isActive}
            badges={badges}
            onClick={onClose}
          />

        </nav>

        {/* ── Footer ────────────────────────────────────────── */}
        <div className="px-5 py-3 border-t border-slate-700/60 flex items-center justify-between">
          {onSignOut && (
            <button onClick={onSignOut}
              className="flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors">
              <LogOut className="w-4 h-4" /> Sair
            </button>
          )}
          <p className="text-xs text-slate-600">v1.0</p>
        </div>
      </aside>
    </>
  );
}

import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Activity, FileText, Layers, Award, DollarSign, Pause,
  Users, BarChart3, TrendingUp, Wallet, HandCoins,
  ShoppingCart, Megaphone, Undo2,
  LayoutDashboard, Package, Tag, UserCheck, Truck, Ticket, Palette, Settings,
  ChevronDown, ChevronRight, X, LogOut, Inbox, AlertCircle, Zap, RefreshCcw, UserPlus, ListChecks,
  MessageCircle, CalendarDays,
} from 'lucide-react';
import { cn, todayLocalStr, toLocalDateStr } from '@/lib/utils';
import { supabase } from '@/api/db';
import { isAwaitingCharge, isOpenCollectionSale, isOpenSaleForFinancial } from '@/lib/sales';
import { RENEWAL_ATTENTION_WINDOW_DAYS } from '@/lib/assessment-renewal-window';

// ─────────────────────────────────────────────────────────────────
// ITENS DE NAVEGAÇÃO
// ─────────────────────────────────────────────────────────────────

const TODAY_ITEM = { label: 'Hoje', icon: Inbox, to: '/hoje', exact: true, badge: 'today' };
const DASHBOARD_ITEM = { label: 'Visão geral', icon: LayoutDashboard, to: '/admin', exact: true };
const COMMUNICATION_ITEM = { label: 'Comunicação', icon: MessageCircle, to: '/comunicacao' };
const OPEN_SALES_ITEM = { label: 'Vendas em aberto', icon: AlertCircle, to: '/financeiro', exact: true, badge: 'openSales' };
const CASH_FLOW_ITEM = { label: 'Fluxo de caixa', icon: TrendingUp, to: '/financeiro/fluxo-caixa' };
const REFUNDS_ITEM = { label: 'Estornos', icon: HandCoins, to: '/estornos' };
const REPORTS_ITEM = { label: 'Relatórios', icon: BarChart3, to: '/relatorios' };
const CLIENTS_ITEM = { label: 'Clientes', icon: Users, to: '/clientes', badge: 'clients' };

const CENTRAL_ITEMS = [
  TODAY_ITEM,
  DASHBOARD_ITEM,
  COMMUNICATION_ITEM,
  OPEN_SALES_ITEM,
  CASH_FLOW_ITEM,
  REFUNDS_ITEM,
  REPORTS_ITEM,
  CLIENTS_ITEM,
];

// OPERAÇÃO — assessoria esportiva
const ASSESSORIA_ITEMS = [
  { label: 'Painel',         icon: Activity,      to: '/assessoria',              exact: true },
  { label: 'Contratos',      icon: FileText,      to: '/assessoria/contratos',    badge: 'assessoria' },
  { label: 'Licenças',       icon: Pause,         to: '/assessoria/licencas' },
  { label: 'Alunos',         icon: Users,         to: '/assessoria/alunos' },
  { label: 'Renovações',     icon: RefreshCcw,    to: '/assessoria/renovacoes',   badge: 'renewals' },
  { label: 'Prospects',      icon: UserPlus,      to: '/assessoria/prospects',    badge: 'prospects' },
  { label: 'Auditoria',      icon: ListChecks,    to: '/assessoria/auditoria' },
  { label: 'Coaches',        icon: Award,         to: '/assessoria/coaches' },
  { label: 'Planos',         icon: Layers,        to: '/assessoria/planos' },
  { label: 'Central financeira', icon: Wallet,    to: '/assessoria/central-financeira' },
  { label: 'Repasse',        icon: DollarSign,    to: '/assessoria/repasse' },
  { label: 'Fechamento',     icon: DollarSign,    to: '/assessoria/fechamento' },
];

// LOJA — módulo secundário (colapsável)
const LOJA_ITEMS = [
  { label: 'Produtos',       icon: Package,       to: '/produtos',                exact: true },
  { label: 'Pedidos',        icon: ShoppingCart,  to: '/pedidos',                 exact: true, badge: 'orders' },
  { label: 'Coleções',       icon: Megaphone,     to: '/campanhas' },
  { label: 'Pré-venda',      icon: Megaphone,     to: '/produtos/pre-venda' },
  { label: 'Devoluções',     icon: Undo2,         to: '/devolucoes' },
];

const EVENTOS_ITEMS = [
  { label: 'Painel de eventos', icon: CalendarDays, to: '/eventos', badge: 'events' },
];

// CONFIGURAÇÕES (colapsável)
const CONFIG_ITEMS = [
  { label: 'Categorias',        icon: Tag,             to: '/categorias' },
  { label: 'Treinadores',       icon: UserCheck,       to: '/treinadores' },
  { label: 'Fornecedores',      icon: Truck,           to: '/fornecedores' },
  { label: 'Cupons',            icon: Ticket,          to: '/cupons' },
  { label: 'Centros receita',   icon: Palette,         to: '/centros-receita' },
  { label: 'Comunicação',       icon: MessageCircle,   to: '/comunicacao/configuracoes' },
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

function CollapseSection({
  label,
  icon: Icon,
  items,
  isActive,
  badges,
  onClick,
  defaultOpen = false,
  helper = null,
  badgeKey = null,
  tone = 'slate',
}) {
  const location = useLocation();
  const isInGroup = items.some(item =>
    item.exact ? location.pathname === item.to : location.pathname.startsWith(item.to)
  );
  const [manuallyOpen, setManuallyOpen] = useState(defaultOpen);
  const open = manuallyOpen || isInGroup;
  const badgeCount = badgeKey ? (badges[badgeKey] || 0) : 0;
  const tones = {
    blue: {
      shell: open ? 'border-blue-500/40 bg-blue-500/10' : 'border-slate-700/60 bg-slate-800/30',
      icon: open ? 'bg-blue-500 text-white' : 'bg-slate-800 text-slate-300',
      text: open ? 'text-blue-100' : 'text-slate-200',
      helper: open ? 'text-blue-200/80' : 'text-slate-400',
      badge: 'bg-blue-500/15 text-blue-100 border border-blue-400/20',
    },
    amber: {
      shell: open ? 'border-amber-500/40 bg-amber-500/10' : 'border-slate-700/60 bg-slate-800/30',
      icon: open ? 'bg-amber-500 text-slate-950' : 'bg-slate-800 text-slate-300',
      text: open ? 'text-amber-100' : 'text-slate-200',
      helper: open ? 'text-amber-100/75' : 'text-slate-400',
      badge: 'bg-amber-500/15 text-amber-100 border border-amber-400/20',
    },
    emerald: {
      shell: open ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-slate-700/60 bg-slate-800/30',
      icon: open ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800 text-slate-300',
      text: open ? 'text-emerald-100' : 'text-slate-200',
      helper: open ? 'text-emerald-100/75' : 'text-slate-400',
      badge: 'bg-emerald-500/15 text-emerald-100 border border-emerald-400/20',
    },
  };
  const styles = tones[tone] || tones.blue;

  return (
    <div className={cn('mt-2 rounded-2xl border transition-colors', styles.shell)}>
      <button
        onClick={() => setManuallyOpen(o => !o)}
        className="w-full flex items-center gap-3 px-3.5 py-3 text-left transition-colors"
      >
        <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', styles.icon)}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn('text-sm font-semibold', styles.text)}>{label}</span>
            {badgeCount > 0 && (
              <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold', styles.badge)}>
                {badgeCount}
              </span>
            )}
          </div>
          {helper && (
            <p className={cn('mt-0.5 text-xs', styles.helper)}>{helper}</p>
          )}
        </div>
        {open ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
      </button>
      {open && (
        <div className="mx-3.5 mb-3 border-l border-slate-700/60 pl-3">
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
  const [badges, setBadges] = useState({
    orders: 0,
    clients: 0,
    today: 0,
    assessoria: 0,
    renewals: 0,
    prospects: 0,
    openSales: 0,
    events: 0,
  });

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
        const renewalWindowEnd = new Date();
        renewalWindowEnd.setDate(renewalWindowEnd.getDate() + RENEWAL_ATTENTION_WINDOW_DAYS);
        const renewalWindowEndStr = toLocalDateStr(renewalWindowEnd);

        const [presaleOrders, stockOrders, eventRegistrations, eventTypes, returnsRes, clientsRes, contractsOverdue, contractsExpiring, pendingRefunds, renewalDrafts, prospectDrafts, contractsOpenPayments] = await Promise.all([
          supabase.from('presale_orders').select('id, payment_status, due_date, created_date, updated_at, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, external_invoice_number, payment_message_sent_at')
            .neq('payment_status', 'cancelled').neq('payment_status', 'refunded'),
          supabase.from('stock_orders').select('id, payment_status, due_date, created_date, updated_at, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, external_invoice_number, payment_message_sent_at')
            .neq('payment_status', 'cancelled').neq('payment_status', 'refunded'),
          supabase.from('event_registrations').select('id, payment_status, due_date, created_at, updated_at, registration_type_id, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, external_invoice_number, payment_message_sent_at')
            .neq('payment_status', 'cancelled').neq('payment_status', 'refunded'),
          supabase.from('event_registration_types').select('id, price'),
          supabase.from('order_returns').select('id', { count: 'exact', head: true })
            .in('status', ['pending_return', 'received']),
          supabase.from('presale_customers').select('id', { count: 'exact', head: true })
            .or('cpf.is.null,cpf.eq.""'),
          supabase.from('assessment_contracts').select('id', { count: 'exact', head: true })
            .eq('status', 'overdue'),
          supabase.from('assessment_contracts').select('id', { count: 'exact', head: true })
            .eq('status', 'active').lte('end_date', renewalWindowEndStr).gte('end_date', todayStr),
          supabase.from('assessment_contracts').select('id', { count: 'exact', head: true })
            .eq('refund_status', 'pending'),
          supabase.from('assessment_contracts').select('id', { count: 'exact', head: true })
            .eq('status', 'draft').not('parent_contract_id', 'is', null),
          supabase.from('assessment_contracts').select('id', { count: 'exact', head: true })
            .eq('status', 'draft').is('parent_contract_id', null),
          supabase.from('assessment_contracts')
            .select('id, status, payment_status, due_date, created_at, updated_at, parent_contract_id, prospect_stage, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, external_invoice_number, payment_message_sent_at')
            .not('status', 'in', '("cancelled","voided")')
            .neq('payment_status', 'paid').neq('payment_status', 'refunded'),
        ]);

        const allOrders = [...(presaleOrders.data || []), ...(stockOrders.data || [])];
        const eventTypePriceMap = Object.fromEntries((eventTypes.data || []).map(type => [type.id, Number(type.price) || 0]));
        const eventPendingRows = (eventRegistrations.data || []).filter(reg =>
          (eventTypePriceMap[reg.registration_type_id] || 0) > 0 &&
          !['paid', 'refunded', 'cancelled'].includes(reg.payment_status)
        );
        const eventOpenRows = eventPendingRows.filter(isOpenCollectionSale);
        const openContracts = (contractsOpenPayments.data || []).filter(isOpenCollectionSale);
        const daysSince = value => value
          ? Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000))
          : 0;
        const chargeFollowUps = rows => rows.filter(row =>
          isOpenSaleForFinancial(row) &&
          !isAwaitingCharge(row) &&
          daysSince(row.payment_message_sent_at || row.updated_at || row.created_date || row.created_at) >= 2
        );
        const collectionCandidates = [...allOrders, ...eventPendingRows, ...openContracts];
        const openSalesCount =
          allOrders.filter(isOpenCollectionSale).length +
          eventOpenRows.length +
          openContracts.length;
        const todayCount =
          collectionCandidates.filter(isAwaitingCharge).length +
          collectionCandidates.filter(row => row.due_date && row.due_date < todayStr && isOpenSaleForFinancial(row)).length +
          chargeFollowUps(collectionCandidates).length +
          (returnsRes.count || 0) +
          (pendingRefunds.count || 0);

        setBadges({
          orders:     allOrders.filter(isAwaitingCharge).length,
          clients:    clientsRes.count || 0,
          today:      todayCount,
          assessoria: (contractsOverdue.count || 0) + (contractsExpiring.count || 0),
          renewals:   renewalDrafts.count || 0,
          prospects:  prospectDrafts.count || 0,
          openSales:  openSalesCount,
          events:     eventPendingRows.length,
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
          <SectionLabel label="Central" />
          <div className="rounded-2xl border border-slate-700/60 bg-slate-800/30 p-2">
            {CENTRAL_ITEMS.map(item => (
              <NavItem key={item.to} item={item} isActive={isActive} badges={badges} onClick={onClose} />
            ))}
          </div>

          <SectionLabel label="Categorias" />
          <CollapseSection
            label="Assessoria"
            icon={Activity}
            items={ASSESSORIA_ITEMS}
            isActive={isActive}
            badges={badges}
            onClick={onClose}
            defaultOpen
            helper="Contratos, alunos, renovações e operação da assessoria."
            badgeKey="assessoria"
            tone="blue"
          />
          {badges.assessoria > 0 && (
            <div className="mx-1 mb-1 mt-1 flex items-center gap-1.5 rounded-xl bg-amber-400/10 px-2.5 py-2 text-xs text-amber-400">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span>{badges.assessoria} contrato{badges.assessoria !== 1 ? 's' : ''} exige atenção</span>
            </div>
          )}
          <CollapseSection
            label="Loja"
            icon={ShoppingCart}
            items={LOJA_ITEMS}
            isActive={isActive}
            badges={badges}
            onClick={onClose}
            helper="Produtos, campanhas, pedidos e devoluções."
            badgeKey="orders"
            tone="amber"
          />
          <CollapseSection
            label="Eventos"
            icon={CalendarDays}
            items={EVENTOS_ITEMS}
            isActive={isActive}
            badges={badges}
            onClick={onClose}
            helper="Inscrições, acompanhamento e financeiro dos eventos."
            badgeKey="events"
            tone="emerald"
          />

          {/* ── CONFIGURAÇÕES — colapsável ─────────────────── */}
          <SectionLabel label="Administração" />
          <CollapseSection
            label="Configurações"
            icon={Settings}
            items={CONFIG_ITEMS}
            isActive={isActive}
            badges={badges}
            onClick={onClose}
            helper="Cadastros mestres, parâmetros e saúde do sistema."
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

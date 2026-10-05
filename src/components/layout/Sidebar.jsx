import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Activity, AlertCircle, Archive, Award, BarChart3, CalendarDays, ChevronDown, ChevronRight,
  DollarSign, FileText, HandCoins, HeartPulse, Inbox, Layers, ListChecks,
  LogOut, Megaphone, MessageCircle, Package, Palette, Pause, RefreshCcw,
  Settings, ShoppingCart, Star, Tag, Ticket, TrendingUp, Truck, Undo2,
  UserCheck, UserPlus, Users, Wallet, X, Zap,
} from 'lucide-react';
import { cn, todayLocalStr, toLocalDateStr } from '@/lib/utils';
import { supabase } from '@/api/db';
import { listFinancialDataQuality } from '@/api/client';
import { isAwaitingCharge, isOpenCollectionSale, isOpenSaleForFinancial } from '@/lib/sales';
import { RENEWAL_ATTENTION_WINDOW_DAYS } from '@/lib/assessment-renewal-window';
import { NAV_AREAS, resolveNavigation } from '@/lib/navigation';

const ICONS = {
  today: Inbox, people: Users, assessment: Activity, store: ShoppingCart,
  events: CalendarDays, finance: Wallet, communication: MessageCircle,
  indicators: BarChart3, settings: Settings, renewals: RefreshCcw,
  contracts: FileText, leaves: Pause, prospects: UserPlus, audit: ListChecks,
  plans: Layers, orders: ShoppingCart, products: Package, collections: Megaphone,
  presale: Megaphone, returns: Undo2, charges: AlertCircle, cashflow: TrendingUp,
  reconciliation: ListChecks, refunds: HandCoins, forecast: Wallet,
  payouts: DollarSign, closings: DollarSign, overview: BarChart3,
  analytics: TrendingUp, reports: BarChart3, coaches: Award, trainers: UserCheck,
  categories: Tag, suppliers: Truck, coupons: Ticket, revenue: Palette,
  payment: DollarSign, health: HeartPulse, archive: Archive,
};

const EXPANSION_KEY = 'eon-sidebar-expanded-area';
const RENEWALS_FAVORITE_KEY = 'eon-sidebar-renewals-favorite';

function savedValue(key) {
  try { return window.localStorage.getItem(key); }
  catch { return null; }
}

function saveValue(key, value) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch { /* Storage can be unavailable in private windows. */ }
}

function Badge({ value, selected = false }) {
  if (!value) return null;
  return (
    <span className={cn(
      'rounded-full px-1.5 py-0.5 text-[10px] font-bold min-w-5 text-center',
      selected ? 'bg-white/20 text-white' : 'bg-rose-500 text-white',
    )}>
      {value}
    </span>
  );
}

function NavItem({ item, selected, badges, onClick, trailing = null, compact = false }) {
  const Icon = ICONS[item.icon] || FileText;
  const badge = item.badge ? badges[item.badge] || 0 : 0;
  return (
    <div className="flex items-center gap-1">
      <Link
        to={item.to}
        onClick={onClick}
        aria-current={selected ? 'page' : undefined}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
          selected ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white',
          compact && 'py-1.5 text-xs',
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        <Badge value={badge} selected={selected} />
      </Link>
      {trailing}
    </div>
  );
}

export default function Sidebar({ open, onClose, onSignOut }) {
  const { pathname } = useLocation();
  const selection = resolveNavigation(pathname);
  const [expandedArea, setExpandedArea] = useState(() => savedValue(EXPANSION_KEY) || selection.areaId);
  const [favoriteRenewals, setFavoriteRenewals] = useState(() => savedValue(RENEWALS_FAVORITE_KEY) === 'true');
  const [badges, setBadges] = useState({
    orders: 0, clients: 0, today: 0, assessoria: 0, renewals: 0,
    prospects: 0, openSales: 0, financialQuality: 0, events: 0,
  });

  useEffect(() => {
    if (selection.areaId && NAV_AREAS.find(area => area.id === selection.areaId)?.items) {
      // A área atual abre ao navegar; apenas um grupo fica expandido.
      setExpandedArea(selection.areaId);
    }
  }, [selection.areaId]);

  useEffect(() => { saveValue(EXPANSION_KEY, expandedArea); }, [expandedArea]);
  useEffect(() => { saveValue(RENEWALS_FAVORITE_KEY, String(favoriteRenewals)); }, [favoriteRenewals]);

  // Os indicadores continuam usando as consultas e definições já existentes.
  useEffect(() => {
    const fetchAlerts = async () => {
      try {
        const todayStr = todayLocalStr();
        const renewalWindowEnd = new Date();
        renewalWindowEnd.setDate(renewalWindowEnd.getDate() + RENEWAL_ATTENTION_WINDOW_DAYS);
        const renewalWindowEndStr = toLocalDateStr(renewalWindowEnd);
        const [presaleOrders, stockOrders, eventRegistrations, eventTypes, returnsRes, clientsRes, contractsOverdue, contractsExpiring, pendingRefunds, renewalDrafts, prospectDrafts, contractsOpenPayments, highQualityIssues] = await Promise.all([
          supabase.from('presale_orders').select('id, payment_status, due_date, created_date, updated_at, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, external_invoice_number, payment_message_sent_at')
            .neq('payment_status', 'cancelled').neq('payment_status', 'refunded'),
          supabase.from('stock_orders').select('id, payment_status, due_date, created_date, updated_at, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, external_invoice_number, payment_message_sent_at')
            .neq('payment_status', 'cancelled').neq('payment_status', 'refunded'),
          supabase.from('event_registrations').select('id, payment_status, due_date, created_at, updated_at, registration_type_id, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, external_invoice_number, payment_message_sent_at')
            .neq('payment_status', 'cancelled').neq('payment_status', 'refunded'),
          supabase.from('event_registration_types').select('id, price'),
          supabase.from('order_returns').select('id', { count: 'exact', head: true }).in('status', ['pending_return', 'received']),
          supabase.from('presale_customers').select('id', { count: 'exact', head: true }).or('cpf.is.null,cpf.eq.""'),
          supabase.from('assessment_contracts').select('id', { count: 'exact', head: true }).eq('status', 'overdue'),
          supabase.from('assessment_contracts').select('id', { count: 'exact', head: true }).eq('status', 'active').lte('end_date', renewalWindowEndStr).gte('end_date', todayStr),
          supabase.from('assessment_contracts').select('id', { count: 'exact', head: true }).eq('refund_status', 'pending'),
          supabase.from('assessment_contracts').select('id', { count: 'exact', head: true }).not('parent_contract_id', 'is', null).in('renewal_stage', ['contact_pending', 'waiting_response', 'charge_pending']),
          supabase.from('assessment_contracts').select('id', { count: 'exact', head: true }).eq('status', 'draft').is('parent_contract_id', null),
          supabase.from('assessment_contracts')
            .select('id, status, payment_status, due_date, created_at, updated_at, parent_contract_id, prospect_stage, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, external_invoice_number, payment_message_sent_at')
            .not('status', 'in', '("cancelled","voided")').neq('payment_status', 'paid').neq('payment_status', 'refunded'),
          listFinancialDataQuality({ severity: 'high' }).catch(() => []),
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
          isOpenSaleForFinancial(row) && !isAwaitingCharge(row) &&
          daysSince(row.payment_message_sent_at || row.updated_at || row.created_date || row.created_at) >= 2
        );
        const collectionCandidates = [...allOrders, ...eventPendingRows, ...openContracts];
        const openSalesCount = allOrders.filter(isOpenCollectionSale).length + eventOpenRows.length + openContracts.length;
        const todayCount =
          collectionCandidates.filter(isAwaitingCharge).length +
          collectionCandidates.filter(row => row.due_date && row.due_date < todayStr && isOpenSaleForFinancial(row)).length +
          chargeFollowUps(collectionCandidates).length +
          (returnsRes.count || 0) + (pendingRefunds.count || 0);
        setBadges({
          orders: allOrders.filter(isAwaitingCharge).length,
          clients: clientsRes.count || 0,
          today: todayCount,
          assessoria: (contractsOverdue.count || 0) + (contractsExpiring.count || 0),
          renewals: renewalDrafts.count || 0,
          prospects: prospectDrafts.count || 0,
          openSales: openSalesCount,
          financialQuality: highQualityIssues.length,
          events: eventPendingRows.length,
        });
      } catch { /* Badge failure must not block navigation. */ }
    };
    fetchAlerts();
  }, []);

  const toggleArea = areaId => setExpandedArea(current => current === areaId ? null : areaId);
  const renewals = NAV_AREAS.find(area => area.id === 'assessment').items.find(item => item.id === 'renewals');

  return (
    <>
      {open && <button type="button" aria-label="Fechar menu" className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={onClose} />}
      <aside className={cn(
        'fixed left-0 top-0 z-40 flex h-full w-64 flex-col bg-slate-900 text-white transition-transform duration-200',
        open ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
      )}>
        <div className="flex items-center justify-between border-b border-slate-700/60 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500"><Zap className="h-4 w-4" /></div>
            <div>
              <p className="text-base font-bold leading-none tracking-tight">Endurance ON</p>
              <p className="mt-0.5 text-[10px] leading-none text-slate-400">Gestão & Assessoria</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Fechar menu" className="text-slate-400 hover:text-white lg:hidden"><X className="h-5 w-5" /></button>
        </div>

        <nav aria-label="Navegação principal" className="flex-1 space-y-0.5 overflow-y-auto px-3 py-3">
          {favoriteRenewals && (
            <div className="mb-3 rounded-xl border border-blue-700/40 bg-blue-950/40 p-2">
              <p className="px-2 pb-1 text-[10px] font-bold uppercase tracking-widest text-blue-300">Acesso rápido</p>
              <Link to={renewals.to} onClick={onClose} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-blue-100 hover:bg-blue-900/50">
                <Star className="h-3.5 w-3.5 fill-current" /> Renovações
              </Link>
            </div>
          )}
          {NAV_AREAS.map(area => {
            const Icon = ICONS[area.icon] || FileText;
            const selectedArea = selection.areaId === area.id;
            const expanded = expandedArea === area.id;
            if (area.to) return (
              <NavItem key={area.id} item={area} selected={selectedArea} badges={badges} onClick={onClose} />
            );
            return (
              <div key={area.id} className={cn('rounded-xl', selectedArea && 'bg-slate-800/40')}>
                <button
                  type="button"
                  onClick={() => toggleArea(area.id)}
                  aria-expanded={expanded}
                  aria-controls={`sidebar-${area.id}`}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-slate-200 hover:bg-slate-800 hover:text-white',
                    selectedArea && 'text-blue-200',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{area.label}</span>
                  {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                </button>
                {expanded && (
                  <div id={`sidebar-${area.id}`} className="ml-5 space-y-0.5 border-l border-slate-700 pb-2 pl-2">
                    {area.items.map(item => (
                      <NavItem
                        key={item.id}
                        item={item}
                        selected={selection.itemId === item.id}
                        badges={badges}
                        onClick={onClose}
                        compact
                        trailing={item.id === 'renewals' ? (
                          <button
                            type="button"
                            aria-label={favoriteRenewals ? 'Desafixar Renovações' : 'Fixar Renovações'}
                            title={favoriteRenewals ? 'Desafixar Renovações' : 'Fixar Renovações'}
                            onClick={() => setFavoriteRenewals(current => !current)}
                            className="rounded p-1 text-slate-400 hover:text-amber-300"
                          >
                            <Star className={cn('h-3.5 w-3.5', favoriteRenewals && 'fill-amber-300 text-amber-300')} />
                          </button>
                        ) : null}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <p className="px-3 pt-3 text-[11px] text-slate-500">As páginas antigas continuam acessíveis por seus links.</p>
        </nav>
        <div className="flex items-center justify-between border-t border-slate-700/60 px-5 py-3">
          {onSignOut && <button type="button" onClick={onSignOut} className="flex items-center gap-2 text-sm text-slate-400 hover:text-white"><LogOut className="h-4 w-4" /> Sair</button>}
          <p className="text-xs text-slate-600">v1.0</p>
        </div>
      </aside>
    </>
  );
}

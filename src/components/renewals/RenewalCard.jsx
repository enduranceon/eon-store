import {
  AlertTriangle, CalendarClock, CheckCircle2, ChevronRight, CreditCard, Info,
  Link2, Loader2, MessageCircle, PenLine, Wallet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatCurrency, formatDate } from '@/lib/utils';
import { RENEWAL_STAGE } from '@/lib/assessment-renewal-pipeline';

export const BADGE_TONES = {
  red: 'bg-red-100 text-red-700',
  amber: 'bg-amber-100 text-amber-800',
  blue: 'bg-blue-100 text-blue-700',
  violet: 'bg-violet-100 text-violet-700',
  green: 'bg-green-100 text-green-700',
  gray: 'bg-gray-100 text-gray-600',
};

export const ALERT_TONES = {
  red: { box: 'border-red-200 bg-red-50 text-red-800', Icon: AlertTriangle },
  amber: { box: 'border-amber-200 bg-amber-50 text-amber-900', Icon: AlertTriangle },
  blue: { box: 'border-blue-200 bg-blue-50 text-blue-900', Icon: Info },
};

// Ação principal de cada etapa. O resto fica na janela de detalhes.
export function primaryAction(card) {
  const { contract, state } = card;
  switch (contract.renewal_stage) {
    case RENEWAL_STAGE.CONTACT_PENDING:
      return { key: 'message', label: state.daysToEnd !== null && state.daysToEnd < 0 ? 'Enviar agora' : 'Enviar mensagem', Icon: MessageCircle };
    case RENEWAL_STAGE.WAITING_RESPONSE:
      return contract.renewal_response_code === 'change_plan_or_coach'
        ? { key: 'details', label: 'Resolver mudança', Icon: PenLine }
        : { key: 'response', label: 'Registrar resposta', Icon: CheckCircle2 };
    case RENEWAL_STAGE.CHARGE_PENDING:
      return { key: 'charge', label: 'Registrar cobrança', Icon: CreditCard };
    case RENEWAL_STAGE.WAITING_PAYMENT:
      return state.missingLink
        ? { key: 'charge', label: contract.auto_renewal ? 'Adicionar link' : 'Registrar cobrança', Icon: Link2 }
        : { key: 'payment', label: 'Registrar pagamento', Icon: Wallet };
    default:
      return null;
  }
}

export function RenewalBadge({ tone, children }) {
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${BADGE_TONES[tone] || BADGE_TONES.gray}`}>
      {children}
    </span>
  );
}

export function RenewalAlert({ tone, children }) {
  const meta = ALERT_TONES[tone] || ALERT_TONES.blue;
  const { Icon } = meta;
  return (
    <div className={`flex items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] leading-snug ${meta.box}`}>
      <Icon className="w-3.5 h-3.5 shrink-0 mt-px" />
      <span>{children}</span>
    </div>
  );
}

export default function RenewalCard({ card, coach, modality, onOpen, onAction, busy }) {
  const { contract, customer, state } = card;
  const stage = contract.renewal_stage;
  const terminal = stage === RENEWAL_STAGE.RENEWED || stage === RENEWAL_STAGE.NOT_RENEWED;
  const action = primaryAction(card);
  const planName = contract.plan_snapshot?.name || 'Plano';
  // O nome do plano já costuma trazer a modalidade ("Corrida - Essencial - ...").
  const planLabel = modality?.name && !planName.toLowerCase().includes(modality.name.toLowerCase())
    ? `${modality.name} · ${planName}`
    : planName;
  const showValue = !terminal || stage === RENEWAL_STAGE.RENEWED;
  const ActionIcon = action?.Icon;

  return (
    <div
      className={`rounded-xl border bg-white shadow-sm transition-shadow hover:shadow-md ${
        state.needsAttention ? 'border-l-4 border-l-red-500' : ''
      } ${terminal ? 'opacity-90' : ''}`}
    >
      <button
        type="button"
        onClick={() => onOpen(card)}
        className="w-full text-left p-3 space-y-2 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-mono text-[11px] font-semibold text-gray-500">{contract.contract_number}</p>
            <p className="text-sm font-semibold text-gray-950 leading-tight mt-0.5">{customer?.full_name || '—'}</p>
            <p className="text-[11px] text-muted-foreground line-clamp-2">{planLabel}</p>
          </div>
          {showValue && (
            <span className="text-xs font-bold text-gray-800 shrink-0">{formatCurrency(state.total)}</span>
          )}
        </div>

        {state.badges.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {state.badges.map(badge => (
              <RenewalBadge key={badge.text} tone={badge.tone}>{badge.text}</RenewalBadge>
            ))}
            {coach?.name && <RenewalBadge tone="gray">{coach.name}</RenewalBadge>}
          </div>
        )}
        {state.badges.length === 0 && coach?.name && (
          <div className="flex flex-wrap gap-1">
            <RenewalBadge tone="gray">{coach.name}</RenewalBadge>
          </div>
        )}

        <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11px] text-gray-600">
          {stage === RENEWAL_STAGE.WAITING_PAYMENT || terminal ? (
            <>
              <span className="text-muted-foreground">Nova vigência</span>
              <span className="text-right">{formatDate(contract.start_date)} → {formatDate(contract.end_date)}</span>
            </>
          ) : (
            <>
              <span className="text-muted-foreground">Fim da vigência</span>
              <span className="text-right">{formatDate(state.endDate)}</span>
            </>
          )}
          {stage === RENEWAL_STAGE.WAITING_RESPONSE && contract.renewal_follow_up_at && (
            <>
              <span className="text-muted-foreground">Follow-up</span>
              <span className="text-right flex items-center justify-end gap-1">
                <CalendarClock className="w-3 h-3" /> {formatDate(contract.renewal_follow_up_at)}
              </span>
            </>
          )}
          {stage === RENEWAL_STAGE.WAITING_PAYMENT && !state.missingLink && (
            <>
              <span className="text-muted-foreground">Cobrança</span>
              <span className="text-right">Também em Vendas em aberto</span>
            </>
          )}
        </div>

        {state.alerts.map(alert => (
          <RenewalAlert key={alert.text} tone={alert.tone}>{alert.text}</RenewalAlert>
        ))}

        {terminal && state.leavesLabel && (
          <p className={`text-[11px] ${stage === RENEWAL_STAGE.RENEWED ? 'text-green-700' : 'text-gray-500'}`}>
            {state.leavesLabel}
          </p>
        )}
      </button>

      {action && (
        <div className="flex gap-1.5 px-3 pb-3">
          <Button
            size="sm"
            className="flex-1 h-8"
            disabled={busy}
            onClick={() => onAction(action.key, card)}
          >
            {busy
              ? <Loader2 className="w-3.5 h-3.5 mr-1 shrink-0 animate-spin" />
              : <ActionIcon className="w-3.5 h-3.5 mr-1 shrink-0" />}
            {action.label}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-2"
            disabled={busy}
            title="Mais ações e histórico"
            onClick={() => onOpen(card)}
          >
            <ChevronRight className="w-4 h-4" />
            <span className="sr-only">Mais ações e histórico</span>
          </Button>
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Ban, CalendarClock, CheckCircle2, Clock, CreditCard, ExternalLink, History,
  Link2, Loader2, MessageCircle, PenLine, Send, UserRound, Wallet, XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { supabase } from '@/api/db';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/utils';
import { isSafePaymentUrl } from '@/lib/sales';
import { canResolveAssessmentRenewal } from '@/lib/assessment-renewal-resolution';
import {
  buildRenewalTimeline,
  RENEWAL_RESPONSE_LABELS,
  RENEWAL_STAGE,
  RENEWAL_STAGE_LABELS,
} from '@/lib/assessment-renewal-pipeline';
import { RenewalAlert, RenewalBadge } from '@/components/renewals/RenewalCard';

const PAYMENT_LABELS = {
  pending: 'Aguardando cobrança',
  awaiting_charge: 'A cobrar',
  charge_sent: 'Cobrança enviada',
  overdue: 'Vencido',
  partially_paid: 'Pago parcial',
  paid: 'Pago',
  cancelled: 'Cancelado',
  refunded: 'Reembolsado',
};

function actionsFor(contract, state) {
  const stage = contract.renewal_stage;
  const resolvable = canResolveAssessmentRenewal(contract);
  // Renovação aberta ainda não foi paga: o plano pode ser trocado no contrato.
  const changePlan = { key: 'change_plan', label: 'Trocar plano', Icon: PenLine };
  const closing = [
    changePlan,
    ...(resolvable ? [
      { key: 'decline', label: 'Não vai renovar', Icon: Ban, tone: 'amber' },
      { key: 'discard', label: 'Descartar venda (engano/duplicada)', Icon: XCircle, tone: 'gray' },
    ] : []),
  ];

  if (stage === RENEWAL_STAGE.CONTACT_PENDING) {
    return [
      { key: 'message', label: 'Enviar mensagem', Icon: MessageCircle, primary: true },
      { key: 'response', label: 'Registrar resposta', Icon: CheckCircle2 },
      ...closing,
    ];
  }
  if (stage === RENEWAL_STAGE.WAITING_RESPONSE) {
    const change = contract.renewal_response_code === 'change_plan_or_coach';
    return [
      ...(change ? [
        { key: 'change_resolved', label: 'Mudança resolvida: seguir para cobrança', Icon: CheckCircle2, primary: true },
      ] : []),
      { key: 'response', label: 'Registrar resposta', Icon: CheckCircle2, primary: !change },
      { key: 'message', label: 'Enviar nova mensagem', Icon: MessageCircle },
      { key: 'followup', label: contract.renewal_follow_up_at ? 'Mudar follow-up' : 'Marcar follow-up', Icon: CalendarClock },
      ...(change ? closing.filter(action => action.key !== 'change_plan') : closing),
    ];
  }
  if (stage === RENEWAL_STAGE.CHARGE_PENDING) {
    return [
      { key: 'charge', label: 'Registrar cobrança', Icon: CreditCard, primary: true },
      { key: 'activate', label: 'Aprovar sem cobrança agora', Icon: Clock },
      { key: 'payment', label: 'Atleta já pagou: registrar pagamento', Icon: Wallet },
      ...closing,
    ];
  }
  if (stage === RENEWAL_STAGE.WAITING_PAYMENT) {
    return [
      ...(state.missingLink
        ? [{ key: 'charge', label: contract.auto_renewal ? 'Adicionar link da cobrança' : 'Registrar cobrança', Icon: Link2, primary: true }]
        : [
          { key: 'charge_message', label: 'Enviar cobrança', Icon: Send },
          { key: 'charge', label: 'Atualizar link da cobrança', Icon: Link2 },
        ]),
      { key: 'payment', label: 'Registrar pagamento', Icon: Wallet, primary: !state.missingLink },
      ...closing,
    ];
  }
  return [];
}

function InfoRow({ label, children }) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className="text-gray-900 text-right sm:text-left">{children}</span>
    </>
  );
}

// Janela de detalhes do card: dados, todas as ações da etapa e a linha do
// tempo com os eventos reais gravados (contrato e financeiro).
export default function RenewalDetailDialog({ card, coach, modality, onClose, onAction, busy }) {
  const [timeline, setTimeline] = useState(null);
  const contract = card?.contract;
  const parent = card?.parent;

  useEffect(() => {
    if (!contract?.id) return undefined;
    let active = true;
    const contractIds = [contract.id, parent?.id].filter(Boolean);
    Promise.all([
      supabase.from('assessment_contract_event')
        .select('id, contract_id, event_type, notes, created_at')
        .in('contract_id', contractIds)
        .order('created_at', { ascending: false })
        .limit(200),
      supabase.from('sales_status_events')
        .select('id, order_id, reason, created_at')
        .eq('order_type', 'contract')
        .eq('order_id', contract.id)
        .order('created_at', { ascending: false })
        .limit(50),
    ]).then(([events, saleEvents]) => {
      if (!active) return;
      if (events.error || saleEvents.error) {
        setTimeline([]);
        return;
      }
      setTimeline(buildRenewalTimeline({
        contract,
        parent,
        contractEvents: events.data || [],
        saleEvents: saleEvents.data || [],
      }));
    });
    return () => { active = false; };
  }, [contract, parent]);

  if (!card) return null;
  const { state, customer } = card;
  const actions = actionsFor(contract, state);
  const paymentLink = [contract.asaas_payment_link, contract.external_payment_link].find(isSafePaymentUrl);
  const stageLabel = RENEWAL_STAGE_LABELS[contract.renewal_stage] || contract.renewal_stage;
  const planName = contract.plan_snapshot?.name || '—';
  const planLabel = modality?.name && !planName.toLowerCase().includes(modality.name.toLowerCase())
    ? `${modality.name} · ${planName}`
    : planName;
  const change = contract.renewal_response_code === 'change_plan_or_coach'
    && contract.renewal_stage === RENEWAL_STAGE.WAITING_RESPONSE;

  return (
    <Dialog open={!!card} onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap pr-6">
            <UserRound className="w-5 h-5 text-blue-600" />
            {customer?.full_name || 'Atleta'}
            <RenewalBadge tone="blue">{stageLabel}</RenewalBadge>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-wrap gap-1">
            {state.badges.map(badge => <RenewalBadge key={badge.text} tone={badge.tone}>{badge.text}</RenewalBadge>)}
          </div>
          {state.alerts.length > 0 && (
            <div className="space-y-1.5">
              {state.alerts.map(alert => <RenewalAlert key={alert.text} tone={alert.tone}>{alert.text}</RenewalAlert>)}
            </div>
          )}
          {state.leavesLabel && <p className="text-xs text-muted-foreground">{state.leavesLabel}</p>}

          <div className="grid grid-cols-2 sm:grid-cols-[160px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg border bg-gray-50 p-3 text-sm">
            <InfoRow label="Renovação">
              <Link to={`/assessoria/contratos/${contract.id}`} className="font-mono text-blue-700 hover:underline">
                {contract.contract_number}
              </Link>
              {parent && (
                <span className="text-muted-foreground"> · renova{' '}
                  <Link to={`/assessoria/contratos/${parent.id}`} className="font-mono text-blue-700 hover:underline">
                    {parent.contract_number}
                  </Link>
                </span>
              )}
            </InfoRow>
            <InfoRow label="Plano">{planLabel}</InfoRow>
            <InfoRow label="Coach">{coach?.name || '—'}</InfoRow>
            <InfoRow label="Valor">{formatCurrency(state.total)} · {contract.installments || 1}x</InfoRow>
            <InfoRow label="Fim da vigência atual">{formatDate(state.endDate)}</InfoRow>
            <InfoRow label="Nova vigência">{formatDate(contract.start_date)} → {formatDate(contract.end_date)}</InfoRow>
            <InfoRow label="Pagamento">{PAYMENT_LABELS[contract.payment_status] || contract.payment_status || '—'}</InfoRow>
            <InfoRow label="Cobrança">
              {paymentLink ? (
                <a href={paymentLink} target="_blank" rel="noopener noreferrer" className="text-blue-700 hover:underline inline-flex items-center gap-1">
                  Abrir link <ExternalLink className="w-3 h-3" />
                </a>
              ) : contract.asaas_pix_copy ? 'PIX copia e cola gerado' : 'Sem link cadastrado'}
            </InfoRow>
            {contract.renewal_response_code && (
              <InfoRow label="Resposta">
                {RENEWAL_RESPONSE_LABELS[contract.renewal_response_code]}
                {contract.renewal_response_at && <span className="text-muted-foreground"> · {formatDateTime(contract.renewal_response_at)}</span>}
              </InfoRow>
            )}
            {contract.renewal_follow_up_at && (
              <InfoRow label="Follow-up">{formatDate(contract.renewal_follow_up_at)}</InfoRow>
            )}
            {contract.renewal_last_contact_at && (
              <InfoRow label="Último contato">{formatDateTime(contract.renewal_last_contact_at)}</InfoRow>
            )}
            {contract.renewal_entered_at && (
              <InfoRow label="Entrou no quadro">{formatDateTime(contract.renewal_entered_at)}</InfoRow>
            )}
          </div>

          {change && (
            <div className="rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm text-violet-950 space-y-2">
              <p className="font-semibold">Mudança de plano ou treinador pedida</p>
              <p className="text-xs">
                Faça a mudança pelos ajustes do contrato da renovação (as regras de plano, coach e modalidade continuam valendo).
                Depois confirme aqui para seguir para a cobrança.
              </p>
              <div className="flex flex-wrap gap-2">
                <Link to={`/assessoria/contratos/${contract.id}?ajustar-plano=1`}>
                  <Button size="sm" variant="outline" className="bg-white">
                    <PenLine className="w-3.5 h-3.5 mr-1" /> Trocar plano
                  </Button>
                </Link>
                <Link to={`/assessoria/contratos/${contract.id}`}>
                  <Button size="sm" variant="outline" className="bg-white">
                    <UserRound className="w-3.5 h-3.5 mr-1" /> Trocar coach no contrato
                  </Button>
                </Link>
              </div>
            </div>
          )}

          {actions.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {actions.map(action => {
                const Icon = action.Icon;
                return (
                  <Button
                    key={action.key}
                    variant={action.primary ? 'default' : 'outline'}
                    className={`justify-start h-auto min-h-9 py-2 whitespace-normal text-left ${
                      action.tone === 'amber' ? 'border-amber-200 text-amber-800 hover:bg-amber-50' : ''
                    }`}
                    disabled={busy}
                    onClick={() => onAction(action.key, card)}
                  >
                    {busy
                      ? <Loader2 className="w-4 h-4 mr-1.5 shrink-0 animate-spin" />
                      : <Icon className="w-4 h-4 mr-1.5 shrink-0" />}
                    {action.label}
                  </Button>
                );
              })}
            </div>
          )}

          <div>
            <p className="text-sm font-semibold text-gray-900 flex items-center gap-1.5 mb-2">
              <History className="w-4 h-4 text-gray-500" /> Linha do tempo
            </p>
            {timeline === null ? (
              <div className="py-6 flex justify-center"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
            ) : timeline.length === 0 ? (
              <p className="text-xs text-muted-foreground">Sem registros.</p>
            ) : (
              <ol className="space-y-2 border-l pl-4">
                {timeline.map(row => (
                  <li key={row.id} className="relative">
                    <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-gray-300" />
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(row.at)}{row.fromParent ? ' · contrato anterior' : ''}
                    </p>
                    <p className="text-sm font-medium text-gray-900">{row.title}</p>
                    {row.detail && <p className="text-xs text-gray-600 whitespace-pre-line break-words">{row.detail}</p>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

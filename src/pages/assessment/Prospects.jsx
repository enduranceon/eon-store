import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  UserPlus, ChevronRight, Check, Trash2, Calendar,
  Loader2, CheckCheck, CreditCard, MessageCircle, Copy, ExternalLink, QrCode,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AssessmentContract, AssessmentContractEvent } from '@/api/entities';
import { supabase } from '@/api/db';
import { formatCurrency, formatDate } from '@/lib/utils';
import { phoneDigitsForWhatsApp } from '@/lib/phone';
import { toast } from 'sonner';

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

function contractTotal(c) {
  const base       = Number(c.plan_snapshot?.price_total ?? 0);
  const enrollment = Number(c.enrollment_fee || 0);
  const discount   = Number(c.manual_discount || 0);
  return Math.max(0, base + enrollment - discount);
}

function buildMessage(draft, customer, coach, modality, paymentLink) {
  const total        = contractTotal(draft);
  const installments = draft.installments || 1;
  const months       = draft.plan_snapshot?.period_months || 1;
  const planName     = draft.plan_snapshot?.name
    || (modality ? `${modality.name} · ${months}m` : 'Assessoria');
  const firstName    = customer?.full_name?.split(' ')[0] || 'aluno(a)';

  let m = `Olá, ${firstName}! 👋\n\n`;
  m += `Sua adesão na *Assessoria EON* foi confirmada! 🎉\n\n`;
  m += `📋 Contrato: *${draft.contract_number}*\n`;
  if (modality) m += `🏃 Modalidade: *${modality.name}*\n`;
  m += `📅 Plano: *${planName}* (${months} ${months === 1 ? 'mês' : 'meses'})\n`;
  if (coach) m += `👤 Coach: *${coach.name}*\n`;
  m += `💰 Total: *${formatCurrency(total)}*`;
  if (installments > 1) m += ` em *${installments}x de ${formatCurrency(total / installments)}*`;
  m += '\n';
  if (Number(draft.enrollment_fee) > 0) {
    m += `📌 Matrícula: ${formatCurrency(draft.enrollment_fee)} _(cobrada na 1ª mensalidade)_\n`;
  }
  m += '\n';
  if (paymentLink?.trim()) {
    m += `Segue o link para efetuar o pagamento:\n🔗 ${paymentLink.trim()}\n\n`;
  } else {
    m += `Em breve você receberá o link de pagamento.\n\n`;
  }
  m += `Qualquer dúvida, estamos à disposição! 🏆`;
  return m;
}

// ─────────────────────────────────────────────────────────────────
// MODAL DE CONFIRMAÇÃO
// ─────────────────────────────────────────────────────────────────

function ConfirmModal({ data, onClose, onDone }) {
  const { draft, customer, coach, modality } = data;
  const [step,              setStep]              = useState('confirm'); // 'confirm' | 'message'
  const [paymentLink,       setPaymentLink]       = useState('');
  const [confirming,        setConfirming]        = useState(false);
  const [copied,            setCopied]            = useState(false);
  const [localEnrollment,   setLocalEnrollment]   = useState(Number(draft.enrollment_fee || 0));
  const [localDiscount,     setLocalDiscount]     = useState(Number(draft.manual_discount || 0));

  const total        = Math.max(0, Number(draft.plan_snapshot?.price_total ?? 0) + localEnrollment - localDiscount);
  const installments = draft.installments || 1;
  const months       = draft.plan_snapshot?.period_months || 1;
  const planName     = draft.plan_snapshot?.name
    || (modality ? `${modality.name} · ${months}m` : 'Assessoria');

  const doConfirm = async (goToMessage) => {
    setConfirming(true);
    try {
      const updates = {
        status: 'active',
        enrollment_fee:  localEnrollment,
        manual_discount: localDiscount,
      };
      if (paymentLink.trim()) updates.external_payment_link = paymentLink.trim();

      await AssessmentContract.update(draft.id, updates);
      await AssessmentContractEvent.create({
        contract_id: draft.id,
        event_type:  'enrollment_activated',
        payload:     { source: 'public_enrollment', payment_link_provided: !!paymentLink.trim() },
        notes:       'Adesão via formulário público confirmada',
      }).catch(() => {});

      if (goToMessage) {
        setStep('message');
      } else {
        toast.success(`Adesão de ${customer?.full_name} confirmada!`);
        onDone();
      }
    } catch (e) {
      toast.error('Erro ao confirmar: ' + (e.message || ''));
    } finally {
      setConfirming(false);
    }
  };

  const effectiveDraft = { ...draft, enrollment_fee: localEnrollment, manual_discount: localDiscount };
  const message = buildMessage(effectiveDraft, customer, coach, modality, paymentLink);

  const copyMessage = () => {
    navigator.clipboard.writeText(message);
    setCopied(true);
    toast.success('Mensagem copiada!');
    setTimeout(() => setCopied(false), 2000);
  };

  const openWhatsApp = () => {
    const phone = phoneDigitsForWhatsApp(customer?.whatsapp);
    if (!phone || phone === '55') return toast.error('WhatsApp do cliente não cadastrado');
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, '_blank');
  };

  // ── Passo 1: Confirmar ──────────────────────────────────────────
  if (step === 'confirm') return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <UserPlus className="w-5 h-5 text-green-600" /> Confirmar adesão
        </DialogTitle>
      </DialogHeader>

      <div className="space-y-4 mt-2">
        {/* Resumo */}
        <div className="bg-gray-50 rounded-xl p-4 space-y-2 text-sm">
          <p className="font-semibold text-gray-900 text-base">{customer?.full_name}</p>
          {customer?.whatsapp && (
            <p className="text-muted-foreground text-xs">{customer.whatsapp}</p>
          )}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2">
            <span className="text-muted-foreground">Plano</span>
            <span className="font-medium">{planName}</span>
            <span className="text-muted-foreground">Modalidade</span>
            <span className="font-medium capitalize">{modality?.name || '—'}</span>
            <span className="text-muted-foreground">Coach</span>
            <span className="font-medium">{coach?.name || '—'}</span>
            <span className="text-muted-foreground">Valor</span>
            <span className="font-bold text-green-700">
              {formatCurrency(total)}
              {installments > 1 && (
                <span className="font-normal text-muted-foreground text-xs ml-1">
                  ({installments}x de {formatCurrency(total / installments)})
                </span>
              )}
            </span>
            <span className="text-muted-foreground">Pagamento</span>
            <span className="flex items-center gap-1">
              {draft.payment_method === 'card'
                ? <><CreditCard className="w-3.5 h-3.5" /> Cartão</>
                : <><QrCode className="w-3.5 h-3.5" /> PIX / Boleto</>
              }
            </span>
          </div>
        </div>

        {/* Ajustes antes de confirmar */}
        <div className="space-y-3 border rounded-xl p-3 bg-gray-50">
          <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Ajustes (opcional)</p>
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <Label className="text-xs text-amber-700 mb-1 block">Taxa de matrícula</Label>
              <input
                type="number" min="0" step="0.01"
                value={localEnrollment}
                onChange={e => setLocalEnrollment(Math.max(0, Number(e.target.value)))}
                className="w-full border rounded-lg px-2.5 py-1.5 text-sm"
              />
            </div>
            {localEnrollment > 0 && (
              <button type="button" onClick={() => setLocalEnrollment(0)}
                className="text-xs text-red-500 hover:underline mt-5 shrink-0">
                Zerar
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <Label className="text-xs text-blue-700 mb-1 block">Desconto manual (R$)</Label>
              <input
                type="number" min="0" step="0.01"
                value={localDiscount}
                onChange={e => setLocalDiscount(Math.max(0, Number(e.target.value)))}
                className="w-full border rounded-lg px-2.5 py-1.5 text-sm"
              />
            </div>
            {localDiscount > 0 && (
              <button type="button" onClick={() => setLocalDiscount(0)}
                className="text-xs text-red-500 hover:underline mt-5 shrink-0">
                Remover
              </button>
            )}
          </div>
          {(localEnrollment !== Number(draft.enrollment_fee || 0) || localDiscount !== Number(draft.manual_discount || 0)) && (
            <p className="text-xs text-green-700 font-semibold">
              Total ajustado: {formatCurrency(total)}
              {installments > 1 && <span className="font-normal text-muted-foreground ml-1">({installments}x de {formatCurrency(total / installments)})</span>}
            </p>
          )}
        </div>

        {/* Link de pagamento opcional */}
        <div>
          <Label className="text-sm">Link de pagamento <span className="text-muted-foreground font-normal">(opcional)</span></Label>
          <p className="text-xs text-muted-foreground mb-1.5">
            Cole aqui o link gerado no Asaas. Se ainda não tiver, pode confirmar e adicionar depois.
          </p>
          <Input
            placeholder="https://asaas.com/c/..."
            value={paymentLink}
            onChange={e => setPaymentLink(e.target.value)}
            className="text-sm"
          />
        </div>

        <div className="flex gap-2 pt-1">
          <Button variant="outline" className="flex-1" onClick={onClose} disabled={confirming}>
            Cancelar
          </Button>
          <Button variant="outline" className="flex-1" onClick={() => doConfirm(false)} disabled={confirming}>
            {confirming ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <Check className="w-4 h-4 mr-1.5" />}
            Só confirmar
          </Button>
          <Button className="flex-1 bg-green-600 hover:bg-green-700" onClick={() => doConfirm(true)} disabled={confirming}>
            {confirming ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <MessageCircle className="w-4 h-4 mr-1.5" />}
            Confirmar e enviar
          </Button>
        </div>
      </div>
    </>
  );

  // ── Passo 2: Mensagem pronta ────────────────────────────────────
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <MessageCircle className="w-5 h-5 text-green-600" /> Mensagem pronta
        </DialogTitle>
      </DialogHeader>

      <div className="space-y-4 mt-2">
        <p className="text-sm text-muted-foreground">
          Adesão de <b>{customer?.full_name}</b> confirmada! Agora envie a cobrança.
        </p>

        {/* Link de pagamento */}
        <div>
          <Label className="text-sm">Link de pagamento</Label>
          <div className="flex gap-2 mt-1">
            <Input
              placeholder="Cole o link do Asaas aqui..."
              value={paymentLink}
              onChange={e => setPaymentLink(e.target.value)}
              className="text-sm"
            />
            {paymentLink.trim() && (
              <a href={paymentLink.trim()} target="_blank" rel="noreferrer">
                <Button size="icon" variant="outline"><ExternalLink className="w-4 h-4" /></Button>
              </a>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Gere o link no Asaas, cole aqui e a mensagem abaixo atualiza automaticamente.
          </p>
        </div>

        {/* Preview da mensagem */}
        <div>
          <Label className="text-sm mb-1.5 block">Preview da mensagem</Label>
          <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-sm whitespace-pre-wrap font-mono text-xs leading-relaxed text-gray-800 max-h-56 overflow-y-auto">
            {message}
          </div>
        </div>

        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={copyMessage}>
            {copied ? <Check className="w-4 h-4 mr-1.5 text-green-600" /> : <Copy className="w-4 h-4 mr-1.5" />}
            {copied ? 'Copiado!' : 'Copiar mensagem'}
          </Button>
          <Button
            className="flex-1 bg-green-600 hover:bg-green-700"
            onClick={openWhatsApp}
            disabled={!customer?.whatsapp}
          >
            <MessageCircle className="w-4 h-4 mr-1.5" /> Abrir WhatsApp
          </Button>
        </div>

        <div className="flex items-center justify-between pt-1 border-t">
          <Link to={`/assessoria/contratos/${draft.id}`} onClick={onClose}>
            <Button variant="ghost" size="sm" className="text-blue-600">
              Ver contrato <ChevronRight className="w-3.5 h-3.5 ml-1" />
            </Button>
          </Link>
          <Button variant="ghost" size="sm" onClick={() => { onDone(); }}>
            Fechar
          </Button>
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────
// LINHA DO PROSPECT
// ─────────────────────────────────────────────────────────────────

function ProspectRow({ draft, customer, coach, modality, onConfirm, onRefuse, busy }) {
  const total        = contractTotal(draft);
  const installments = draft.installments || 1;
  const planName     = draft.plan_snapshot?.name
    || (modality ? `${modality.name} · ${draft.plan_snapshot?.period_months || ''}m` : 'Plano');

  return (
    <Card className="border-green-200 hover:border-green-300 transition-colors">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-sm font-semibold text-green-700">{draft.contract_number}</span>
              <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-medium">Pendente</span>
            </div>
            <p className="text-base font-semibold text-gray-900 mt-1">{customer?.full_name || '—'}</p>
            <p className="text-xs text-muted-foreground capitalize mt-0.5">
              {modality?.name || '—'} · {planName}
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                {formatDate(draft.start_date)} → {formatDate(draft.end_date)}
              </span>
              {coach && <span>Coach: <b className="text-gray-700">{coach.name}</b></span>}
              <span className="flex items-center gap-1">
                <CreditCard className="w-3 h-3" />
                {installments}x de <b className="text-gray-700 ml-1">{formatCurrency(total / installments)}</b>
              </span>
              <span>{draft.payment_method === 'card' ? 'Cartão de crédito' : 'PIX / Boleto'}</span>
            </div>
          </div>

          <div className="flex flex-col items-end gap-2 shrink-0">
            <span className="font-bold text-green-700 text-base">{formatCurrency(total)}</span>
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" disabled={busy}
                className="border-red-200 text-red-700 hover:bg-red-50"
                onClick={() => onRefuse(draft, customer)}>
                <Trash2 className="w-3.5 h-3.5 mr-1" /> Recusar
              </Button>
              <Link to={`/assessoria/contratos/${draft.id}`}>
                <Button size="sm" variant="outline" disabled={busy}>
                  Ver <ChevronRight className="w-3.5 h-3.5 ml-1" />
                </Button>
              </Link>
              <Button size="sm" disabled={busy}
                className="bg-green-600 hover:bg-green-700"
                onClick={() => onConfirm(draft, customer, coach, modality)}>
                <Check className="w-3.5 h-3.5 mr-1" /> Confirmar
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────
// PÁGINA PRINCIPAL
// ─────────────────────────────────────────────────────────────────

export default function Prospects() {
  const [drafts,     setDrafts]     = useState([]);
  const [customers,  setCustomers]  = useState({});
  const [coaches,    setCoaches]    = useState({});
  const [modalities, setModalities] = useState({});
  const [loading,    setLoading]    = useState(true);
  const [busy,       setBusy]       = useState(null);
  const [modal,      setModal]      = useState(null); // { draft, customer, coach, modality }

  const load = async () => {
    setLoading(true);
    try {
      const { data: draftsData } = await supabase
        .from('assessment_contracts')
        .select('id, contract_number, customer_id, coach_id, plan_snapshot, start_date, end_date, installments, enrollment_fee, manual_discount, payment_method, notes, created_at')
        .eq('status', 'draft')
        .is('parent_contract_id', null)
        .order('created_at', { ascending: false });

      const list = draftsData || [];
      setDrafts(list);

      if (list.length === 0) {
        setCustomers({}); setCoaches({}); setModalities({});
        setLoading(false); return;
      }

      const customerIds = [...new Set(list.map(d => d.customer_id).filter(Boolean))];
      const coachIds    = [...new Set(list.map(d => d.coach_id).filter(Boolean))];
      const modalityIds = [...new Set(list.map(d => d.plan_snapshot?.modality_id).filter(Boolean))];

      const [custRes, coachRes, modRes] = await Promise.all([
        customerIds.length ? supabase.from('presale_customers').select('id, full_name, whatsapp, cpf').in('id', customerIds) : Promise.resolve({ data: [] }),
        coachIds.length    ? supabase.from('assessment_coaches').select('id, name').in('id', coachIds)                        : Promise.resolve({ data: [] }),
        modalityIds.length ? supabase.from('assessment_modalities').select('id, name').in('id', modalityIds)                  : Promise.resolve({ data: [] }),
      ]);

      setCustomers(Object.fromEntries((custRes.data  || []).map(c => [c.id, c])));
      setCoaches(Object.fromEntries((coachRes.data   || []).map(c => [c.id, c])));
      setModalities(Object.fromEntries((modRes.data  || []).map(m => [m.id, m])));
    } catch (e) {
      console.error(e);
      toast.error('Erro ao carregar prospects: ' + (e.message || ''));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openConfirm = (draft, customer, coach, modality) => {
    setModal({ draft, customer, coach, modality });
  };

  const refuseEnrollment = async (draft, customer) => {
    const name = customer?.full_name || draft.contract_number;
    if (!confirm(`Recusar a adesão de ${name}?\n\nO registro será excluído permanentemente.`)) return;
    setBusy(draft.id);
    try {
      await AssessmentContract.delete(draft.id);
      toast.success('Adesão recusada e removida');
      load();
    } catch (e) {
      toast.error('Erro ao recusar: ' + (e.message || ''));
    } finally {
      setBusy(null);
    }
  };

  const totalValue = drafts.reduce((s, d) => s + contractTotal(d), 0);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <UserPlus className="w-5 h-5 text-green-600" />
            Prospects
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Adesões recebidas pelo formulário público aguardando confirmação
          </p>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-full bg-green-50 shrink-0">
              <UserPlus className="w-5 h-5 text-green-600" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Pendentes</p>
              <p className="text-2xl font-bold text-green-700">{drafts.length}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-full bg-blue-50 shrink-0">
              <CreditCard className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Valor potencial</p>
              <p className="text-2xl font-bold text-blue-700">{formatCurrency(totalValue)}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 gap-3 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Carregando...</span>
        </div>
      ) : drafts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16 text-center">
            <CheckCheck className="w-10 h-10 text-green-500 mb-3" />
            <p className="text-base font-semibold text-gray-700">Nenhum prospect pendente</p>
            <p className="text-sm text-muted-foreground mt-1">
              Quando alguém preencher o formulário público, aparece aqui para confirmação.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {drafts.map(draft => (
            <ProspectRow
              key={draft.id}
              draft={draft}
              customer={customers[draft.customer_id]}
              coach={coaches[draft.coach_id]}
              modality={modalities[draft.plan_snapshot?.modality_id]}
              onConfirm={openConfirm}
              onRefuse={refuseEnrollment}
              busy={busy === draft.id}
            />
          ))}
        </div>
      )}

      {/* Modal de confirmação + mensagem */}
      <Dialog open={!!modal} onOpenChange={open => { if (!open) { setModal(null); load(); } }}>
        <DialogContent className="max-w-md">
          {modal && (
            <ConfirmModal
              data={modal}
              onClose={() => { setModal(null); load(); }}
              onDone={() => { setModal(null); load(); }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

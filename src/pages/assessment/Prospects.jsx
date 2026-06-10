import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  UserPlus, ChevronRight, Check, Trash2, Calendar,
  Loader2, CheckCheck, CreditCard,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AssessmentContract, AssessmentContractEvent } from '@/api/entities';
import { supabase } from '@/api/db';
import { formatCurrency, formatDate } from '@/lib/utils';
import { toast } from 'sonner';

function contractTotal(c) {
  const base       = Number(c.plan_snapshot?.price_total ?? 0);
  const enrollment = Number(c.enrollment_fee || 0);
  const discount   = Number(c.manual_discount || 0);
  return Math.max(0, base + enrollment - discount);
}

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
              {draft.payment_method && (
                <span>{draft.payment_method === 'card' ? 'Cartão de crédito' : 'PIX / Boleto'}</span>
              )}
            </div>
          </div>

          <div className="flex flex-col items-end gap-2 shrink-0">
            <span className="font-bold text-green-700 text-base">{formatCurrency(total)}</span>
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" disabled={busy}
                className="border-red-200 text-red-700 hover:bg-red-50"
                onClick={() => onRefuse(draft)}>
                <Trash2 className="w-3.5 h-3.5 mr-1" /> Recusar
              </Button>
              <Link to={`/assessoria/contratos/${draft.id}`}>
                <Button size="sm" variant="outline" disabled={busy}>
                  Ver <ChevronRight className="w-3.5 h-3.5 ml-1" />
                </Button>
              </Link>
              <Button size="sm" disabled={busy}
                className="bg-green-600 hover:bg-green-700"
                onClick={() => onConfirm(draft)}>
                <Check className="w-3.5 h-3.5 mr-1" /> Confirmar
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Prospects() {
  const [drafts,     setDrafts]     = useState([]);
  const [customers,  setCustomers]  = useState({});
  const [coaches,    setCoaches]    = useState({});
  const [modalities, setModalities] = useState({});
  const [loading,    setLoading]    = useState(true);
  const [busy,       setBusy]       = useState(null);

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

  const confirmEnrollment = async (draft) => {
    const name = customers[draft.customer_id]?.full_name || draft.contract_number;
    if (!confirm(`Confirmar adesão de ${name}?\n\nO contrato será ativado. Lembre de gerar a cobrança no detalhe do contrato.`)) return;
    setBusy(draft.id);
    try {
      await AssessmentContract.update(draft.id, { status: 'active' });
      await AssessmentContractEvent.create({
        contract_id: draft.id,
        event_type:  'enrollment_activated',
        payload:     { source: 'public_enrollment' },
        notes:       'Adesão via formulário público confirmada',
      }).catch(() => {});
      toast.success(`Adesão de ${name} confirmada!`);
      load();
    } catch (e) {
      toast.error('Erro ao confirmar: ' + (e.message || ''));
    } finally {
      setBusy(null);
    }
  };

  const refuseEnrollment = async (draft) => {
    const name = customers[draft.customer_id]?.full_name || draft.contract_number;
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
              onConfirm={confirmEnrollment}
              onRefuse={refuseEnrollment}
              busy={busy === draft.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

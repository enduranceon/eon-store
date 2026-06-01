import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  RefreshCcw, RotateCcw, ChevronRight, Check, Trash2, AlertTriangle,
  Calendar, Loader2, CheckCheck, Inbox, Activity,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AssessmentContract, AssessmentContractEvent, AssessmentCoach, AssessmentPlan,
  AssessmentModality, PreSaleCustomer,
} from '@/api/entities';
import { supabase } from '@/api/db';
import { formatCurrency, formatDate, toLocalDateStr } from '@/lib/utils';
import { toast } from 'sonner';

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

function snapPrice(contract) {
  return Number(
    contract.plan_snapshot?.price_total
    ?? contract.plan?.price_total
    ?? 0
  );
}

function contractTotal(contract) {
  const base = snapPrice(contract);
  const enrollment = Number(contract.enrollment_fee || 0);
  const discount   = Number(contract.manual_discount || 0);
  return Math.max(0, base + enrollment - discount);
}

// ─────────────────────────────────────────────────────────────────
// LINHA DA RENOVAÇÃO PENDENTE
// ─────────────────────────────────────────────────────────────────

function RenewalRow({ draft, parent, customer, coach, modality, onActivate, onDiscard, busy }) {
  const total = contractTotal(draft);
  const planName = draft.plan_snapshot?.name
    || (modality ? `${modality.name} · ${draft.plan_snapshot?.period_months || ''} m` : 'Plano');
  const installments = draft.installments || 1;
  const valuePerInst = installments > 0 ? total / installments : total;

  return (
    <Card className="border-blue-200">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-sm font-semibold text-blue-700">{draft.contract_number}</span>
              <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">Rascunho</span>
              {parent && (
                <span className="text-[11px] text-muted-foreground">
                  renova <Link to={`/assessoria/contratos/${parent.id}`} className="text-blue-600 hover:underline font-mono">{parent.contract_number}</Link>
                </span>
              )}
            </div>
            <p className="text-sm font-semibold text-gray-900 mt-1">{customer?.full_name || '—'}</p>
            <p className="text-xs text-muted-foreground capitalize">
              {modality?.name || '—'} · {planName}
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                {formatDate(draft.start_date)} → {formatDate(draft.end_date)}
              </span>
              {coach && <span>Coach: <b className="text-gray-700">{coach.name}</b></span>}
              <span>
                {installments}x de <b className="text-gray-700">{formatCurrency(valuePerInst)}</b>
              </span>
            </div>
          </div>

          <div className="flex flex-col items-end gap-2 shrink-0">
            <span className="font-bold text-blue-700 text-base">{formatCurrency(total)}</span>
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" disabled={busy}
                className="border-red-200 text-red-700 hover:bg-red-50"
                onClick={() => onDiscard(draft, parent)}>
                <Trash2 className="w-3.5 h-3.5 mr-1" /> Descartar
              </Button>
              <Link to={`/assessoria/contratos/${draft.id}`}>
                <Button size="sm" variant="outline" disabled={busy}>
                  Revisar <ChevronRight className="w-3.5 h-3.5 ml-1" />
                </Button>
              </Link>
              <Button size="sm" disabled={busy}
                className="bg-green-600 hover:bg-green-700"
                onClick={() => onActivate(draft, parent)}>
                <Check className="w-3.5 h-3.5 mr-1" /> Ativar
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────
// PÁGINA
// ─────────────────────────────────────────────────────────────────

export default function Renewals() {
  const [drafts, setDrafts]         = useState([]);
  const [parents, setParents]       = useState({});
  const [customers, setCustomers]   = useState({});
  const [coaches, setCoaches]       = useState({});
  const [modalities, setModalities] = useState({});
  const [loading, setLoading]       = useState(true);
  const [busy, setBusy]             = useState(null); // id em processamento
  const [scanModal, setScanModal]   = useState(false);
  const [scanForm, setScanForm]     = useState({ horizon_days: 30 });
  const [scanning, setScanning]     = useState(false);
  const [scanResult, setScanResult] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      // 1) Drafts
      const { data: draftsData } = await supabase
        .from('assessment_contracts')
        .select('id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, start_date, end_date, installments, enrollment_fee, manual_discount, payment_method, parent_contract_id, notes, created_at')
        .eq('status', 'draft')
        .order('start_date', { ascending: true });

      const draftsList = draftsData || [];
      setDrafts(draftsList);

      if (draftsList.length === 0) {
        setParents({}); setCustomers({}); setCoaches({}); setModalities({});
        setLoading(false); return;
      }

      // 2) Coletar IDs para enriquecer
      const parentIds   = [...new Set(draftsList.map(d => d.parent_contract_id).filter(Boolean))];
      const customerIds = [...new Set(draftsList.map(d => d.customer_id).filter(Boolean))];
      const coachIds    = [...new Set(draftsList.map(d => d.coach_id).filter(Boolean))];
      const modalityIds = [...new Set(draftsList.map(d => d.plan_snapshot?.modality_id).filter(Boolean))];

      const [parentRes, custRes, coachRes, modRes] = await Promise.all([
        parentIds.length ? supabase.from('assessment_contracts').select('id, contract_number, end_date, payment_status').in('id', parentIds) : Promise.resolve({ data: [] }),
        customerIds.length ? supabase.from('presale_customers').select('id, full_name').in('id', customerIds) : Promise.resolve({ data: [] }),
        coachIds.length ? supabase.from('assessment_coaches').select('id, name').in('id', coachIds) : Promise.resolve({ data: [] }),
        modalityIds.length ? supabase.from('assessment_modalities').select('id, name').in('id', modalityIds) : Promise.resolve({ data: [] }),
      ]);

      setParents(Object.fromEntries((parentRes.data || []).map(p => [p.id, p])));
      setCustomers(Object.fromEntries((custRes.data || []).map(c => [c.id, c])));
      setCoaches(Object.fromEntries((coachRes.data || []).map(c => [c.id, c])));
      setModalities(Object.fromEntries((modRes.data || []).map(m => [m.id, m])));
    } catch (e) {
      console.error('Erro ao carregar renovações:', e);
      toast.error('Erro ao carregar renovações: ' + (e.message || ''));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const activateDraft = async (draft, parent) => {
    if (!confirm(`Ativar contrato ${draft.contract_number}?\n\nO contrato pai será marcado como finalizado.`)) return;
    setBusy(draft.id);
    try {
      // 1) Draft → active
      await AssessmentContract.update(draft.id, { status: 'active' });

      // 2) Pai → finished
      if (parent) {
        await AssessmentContract.update(parent.id, { status: 'finished' });
      }

      // 3) Evento de aprovação
      await AssessmentContractEvent.create({
        contract_id: draft.id,
        event_type:  'renewal_activated',
        payload: {
          parent_contract_id:     parent?.id || null,
          parent_contract_number: parent?.contract_number || null,
        },
        notes: 'Rascunho aprovado e ativado',
      }).catch(() => {});

      toast.success(`Contrato ${draft.contract_number} ativado!`);
      load();
    } catch (e) {
      toast.error('Erro ao ativar: ' + (e.message || ''));
    } finally {
      setBusy(null);
    }
  };

  const discardDraft = async (draft, parent) => {
    if (!confirm(`Descartar a renovação ${draft.contract_number}?\n\nO contrato será excluído e o pai voltará a estar elegível para nova renovação.`)) return;
    setBusy(draft.id);
    try {
      // 1) Remove o draft (cascade limpa eventos via FK ON DELETE CASCADE)
      await AssessmentContract.delete(draft.id);

      // 2) Reseta a flag no pai pra permitir nova tentativa
      if (parent) {
        await AssessmentContract.update(parent.id, { renewal_generated: false });
        // Evento no pai
        await AssessmentContractEvent.create({
          contract_id: parent.id,
          event_type:  'renewal_discarded',
          payload: {
            discarded_draft_id:     draft.id,
            discarded_draft_number: draft.contract_number,
          },
          notes: 'Rascunho de renovação descartado',
        }).catch(() => {});
      }

      toast.success('Rascunho descartado');
      load();
    } catch (e) {
      toast.error('Erro ao descartar: ' + (e.message || ''));
    } finally {
      setBusy(null);
    }
  };

  const runScan = async () => {
    setScanning(true);
    setScanResult(null);
    try {
      const { data, error } = await supabase.functions.invoke('prepare-renewals', {
        body: { horizon_days: Number(scanForm.horizon_days) || 30 },
      });
      if (error) {
        let msg = error.message;
        try {
          if (error.context?.json) {
            const b = await error.context.json();
            if (b?.error) msg = b.error;
          }
        } catch { /* */ }
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      setScanResult(data);
      if (data.drafts_created > 0) {
        toast.success(`${data.drafts_created} rascunho${data.drafts_created !== 1 ? 's' : ''} criado${data.drafts_created !== 1 ? 's' : ''}!`);
        load();
      } else {
        toast.info(data.message || 'Nenhum contrato dentro da janela.');
      }
    } catch (e) {
      toast.error('Erro: ' + (e.message || ''));
    } finally {
      setScanning(false);
    }
  };

  // KPIs simples
  const totalValue = drafts.reduce((s, d) => s + contractTotal(d), 0);
  const upcomingCount = drafts.filter(d => {
    const start = new Date(d.start_date + 'T00:00:00');
    const today = new Date(); today.setHours(0,0,0,0);
    const diff = Math.round((start - today) / 86400000);
    return diff <= 7;
  }).length;

  return (
    <div className="space-y-5">
      {/* Cabeçalho */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <RefreshCcw className="w-5 h-5 text-blue-600" />
            Renovações pendentes
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Rascunhos de contratos gerados automaticamente aguardando aprovação
          </p>
        </div>
        <Button onClick={() => setScanModal(true)} variant="outline">
          <RotateCcw className="w-4 h-4 mr-1.5" />
          Verificar renovações agora
        </Button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-full bg-blue-50 shrink-0"><Inbox className="w-5 h-5 text-blue-600" /></div>
            <div>
              <p className="text-xs text-muted-foreground">Rascunhos pendentes</p>
              <p className="text-xl font-bold text-blue-700">{drafts.length}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-full bg-amber-50 shrink-0"><AlertTriangle className="w-5 h-5 text-amber-600" /></div>
            <div>
              <p className="text-xs text-muted-foreground">Iniciam em ≤ 7 dias</p>
              <p className="text-xl font-bold text-amber-700">{upcomingCount}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-full bg-green-50 shrink-0"><Activity className="w-5 h-5 text-green-700" /></div>
            <div>
              <p className="text-xs text-muted-foreground">Valor potencial</p>
              <p className="text-xl font-bold text-green-700">{formatCurrency(totalValue)}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Lista */}
      {loading ? (
        <div className="flex items-center justify-center py-16 gap-3 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Carregando renovações...</span>
        </div>
      ) : drafts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16 text-center">
            <CheckCheck className="w-10 h-10 text-green-500 mb-3" />
            <p className="text-base font-semibold text-gray-700">Nada pendente por aqui!</p>
            <p className="text-sm text-muted-foreground mt-1">
              Quando contratos estiverem perto do vencimento, rascunhos aparecem aqui para revisão.
            </p>
            <Button className="mt-4" variant="outline" onClick={() => setScanModal(true)}>
              <RotateCcw className="w-4 h-4 mr-1.5" /> Verificar agora
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {drafts.map(draft => (
            <RenewalRow
              key={draft.id}
              draft={draft}
              parent={parents[draft.parent_contract_id]}
              customer={customers[draft.customer_id]}
              coach={coaches[draft.coach_id]}
              modality={modalities[draft.plan_snapshot?.modality_id]}
              onActivate={activateDraft}
              onDiscard={discardDraft}
              busy={busy === draft.id}
            />
          ))}
        </div>
      )}

      {/* Modal: scan */}
      <Dialog open={scanModal} onOpenChange={open => !open && !scanning && setScanModal(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw className="w-5 h-5 text-blue-600" /> Verificar renovações
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Busca contratos próximos do vencimento e gera rascunhos de renovação automaticamente.
              Rascunhos já existentes não são duplicados.
            </p>
            <div>
              <Label>Janela (dias antes do vencimento)</Label>
              <Input
                type="number" min="1" max="90"
                className="mt-1"
                value={scanForm.horizon_days}
                onChange={e => setScanForm(f => ({ ...f, horizon_days: e.target.value }))}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Padrão: 30 dias. Contratos com vencimento dentro desta janela serão considerados.
              </p>
            </div>

            {scanResult && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm space-y-1">
                <p><b>Contratos verificados:</b> {scanResult.processed}</p>
                <p className="text-green-700"><b>Rascunhos criados:</b> {scanResult.drafts_created}</p>
                {scanResult.errors?.length > 0 && (
                  <p className="text-red-700">
                    <b>Erros:</b> {scanResult.errors.length}
                  </p>
                )}
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1"
                onClick={() => { setScanModal(false); setScanResult(null); }}
                disabled={scanning}>
                Fechar
              </Button>
              <Button className="flex-1" onClick={runScan} disabled={scanning}>
                {scanning ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <RotateCcw className="w-4 h-4 mr-1.5" />}
                {scanning ? 'Verificando...' : 'Executar agora'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

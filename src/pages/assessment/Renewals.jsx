import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  RefreshCcw, RotateCcw, ChevronRight, Check, Trash2,
  Calendar, Loader2, CheckCheck, Activity, Ban,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AssessmentContract, AssessmentContractEvent } from '@/api/entities';
import { supabase } from '@/api/db';
import { formatCurrency, formatDate, todayLocalStr, toLocalDateStr } from '@/lib/utils';
import { toast } from 'sonner';
import { RENEWAL_ATTENTION_WINDOW_DAYS } from '@/lib/assessment-renewal-window';

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
  const base       = snapPrice(contract);
  const enrollment = Number(contract.enrollment_fee || 0);
  const discount   = Number(contract.manual_discount || 0);
  return Math.max(0, base + enrollment - discount);
}

const DAY_MS = 86400000;

function localDate(dateStr) {
  if (!dateStr) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))
    ? new Date(`${dateStr}T00:00:00`)
    : new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(dateStr, days) {
  const d = localDate(dateStr);
  if (!d) return '';
  d.setDate(d.getDate() + days);
  return toLocalDateStr(d);
}

function daysBetween(dateStr, todayStr = todayLocalStr()) {
  const target = localDate(dateStr);
  const today = localDate(todayStr);
  if (!target || !today) return null;
  return Math.round((target - today) / DAY_MS);
}

function renewalDate(draft, parent) {
  return parent?.end_date || draft.start_date || draft.end_date || '';
}

function renewalDaysLeft(draft, parent, todayStr = todayLocalStr()) {
  return daysBetween(renewalDate(draft, parent), todayStr);
}

function renewalTimingLabel(daysLeft) {
  if (daysLeft === null) return 'Sem data';
  if (daysLeft < -1) return `Venceu há ${Math.abs(daysLeft)} dias`;
  if (daysLeft === -1) return 'Venceu ontem';
  if (daysLeft === 0) return 'Vence hoje';
  if (daysLeft === 1) return 'Vence amanhã';
  return `Vence em ${daysLeft} dias`;
}

function renewalTimingClass(daysLeft) {
  if (daysLeft === null) return 'bg-gray-100 text-gray-600';
  if (daysLeft <= 0) return 'bg-red-100 text-red-700';
  if (daysLeft <= 3) return 'bg-amber-100 text-amber-700';
  if (daysLeft <= RENEWAL_ATTENTION_WINDOW_DAYS) return 'bg-blue-100 text-blue-700';
  return 'bg-gray-100 text-gray-600';
}

function compareRenewalDrafts(a, b, parents = {}) {
  const parentA = parents[a.parent_contract_id];
  const parentB = parents[b.parent_contract_id];
  const dateA = renewalDate(a, parentA) || '9999-12-31';
  const dateB = renewalDate(b, parentB) || '9999-12-31';
  const byRenewalDate = dateA.localeCompare(dateB);
  if (byRenewalDate !== 0) return byRenewalDate;
  return String(a.created_at || '').localeCompare(String(b.created_at || ''));
}

function normalizeScanDays(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return RENEWAL_ATTENTION_WINDOW_DAYS;
  return Math.max(1, Math.min(90, Math.round(n)));
}

// ─────────────────────────────────────────────────────────────────
// LINHA DE RENOVAÇÃO (gerada automaticamente, tem contrato pai)
// ─────────────────────────────────────────────────────────────────

function RenewalRow({ draft, parent, customer, coach, modality, onActivate, onDecline, onDiscard, busy }) {
  const total        = contractTotal(draft);
  const planName     = draft.plan_snapshot?.name
    || (modality ? `${modality.name} · ${draft.plan_snapshot?.period_months || ''}m` : 'Plano');
  const installments = draft.installments || 1;
  const valuePerInst = installments > 0 ? total / installments : total;
  const daysLeft     = renewalDaysLeft(draft, parent);
  const timingLabel  = renewalTimingLabel(daysLeft);
  const renewAt      = renewalDate(draft, parent);

  return (
    <Card className="border-blue-200">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-sm font-semibold text-blue-700">{draft.contract_number}</span>
              <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">Rascunho</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${renewalTimingClass(daysLeft)}`}>
                {timingLabel}
              </span>
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
                Renovar em {formatDate(renewAt)} · nova vigência {formatDate(draft.start_date)} → {formatDate(draft.end_date)}
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
                className="border-amber-200 text-amber-700 hover:bg-amber-50"
                onClick={() => onDecline(draft, parent)}>
                <Ban className="w-3.5 h-3.5 mr-1" /> Não renovar
              </Button>
              <Button size="sm" variant="outline" disabled={busy}
                className="border-gray-200 text-gray-600 hover:bg-gray-50"
                title="Remove este rascunho e deixa o contrato apto a gerar uma nova renovação."
                onClick={() => onDiscard(draft, parent)}>
                <Trash2 className="w-3.5 h-3.5 mr-1" /> Recriar
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
  const [drafts,     setDrafts]     = useState([]);
  const [parents,    setParents]    = useState({});
  const [customers,  setCustomers]  = useState({});
  const [coaches,    setCoaches]    = useState({});
  const [modalities, setModalities] = useState({});
  const [loading,    setLoading]    = useState(true);
  const [busy,       setBusy]       = useState(null);
  const [scanModal,  setScanModal]  = useState(false);
  const [scanForm,   setScanForm]   = useState({ horizon_days: RENEWAL_ATTENTION_WINDOW_DAYS });
  const [scanning,   setScanning]   = useState(false);
  const [scanResult, setScanResult] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: draftsData } = await supabase
        .from('assessment_contracts')
        .select('id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, start_date, end_date, installments, enrollment_fee, manual_discount, payment_method, parent_contract_id, notes, created_at')
        .eq('status', 'draft')
        .not('parent_contract_id', 'is', null)
        .order('start_date', { ascending: true })
        .order('created_at', { ascending: true });

      const draftsList = [...(draftsData || [])].sort(compareRenewalDrafts);
      setDrafts(draftsList);

      if (draftsList.length === 0) {
        setParents({}); setCustomers({}); setCoaches({}); setModalities({});
        setLoading(false); return;
      }

      const parentIds   = [...new Set(draftsList.map(d => d.parent_contract_id).filter(Boolean))];
      const customerIds = [...new Set(draftsList.map(d => d.customer_id).filter(Boolean))];
      const coachIds    = [...new Set(draftsList.map(d => d.coach_id).filter(Boolean))];
      const modalityIds = [...new Set(draftsList.map(d => d.plan_snapshot?.modality_id).filter(Boolean))];

      const [parentRes, custRes, coachRes, modRes] = await Promise.all([
        parentIds.length   ? supabase.from('assessment_contracts').select('id, contract_number, status, end_date, payment_status').in('id', parentIds) : Promise.resolve({ data: [] }),
        customerIds.length ? supabase.from('presale_customers').select('id, full_name').in('id', customerIds)                                    : Promise.resolve({ data: [] }),
        coachIds.length    ? supabase.from('assessment_coaches').select('id, name').in('id', coachIds)                                           : Promise.resolve({ data: [] }),
        modalityIds.length ? supabase.from('assessment_modalities').select('id, name').in('id', modalityIds)                                     : Promise.resolve({ data: [] }),
      ]);

      setParents(Object.fromEntries((parentRes.data || []).map(p => [p.id, p])));
      setCustomers(Object.fromEntries((custRes.data  || []).map(c => [c.id, c])));
      setCoaches(Object.fromEntries((coachRes.data   || []).map(c => [c.id, c])));
      setModalities(Object.fromEntries((modRes.data  || []).map(m => [m.id, m])));
    } catch (e) {
      console.error('Erro ao carregar pendentes:', e);
      toast.error('Erro ao carregar: ' + (e.message || ''));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { load(); }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  // ── Ações: renovação ─────────────────────────────────────────────────────

  const activateRenewal = async (draft, parent) => {
    if (!confirm(`Ativar renovação ${draft.contract_number}?\n\nO contrato anterior será marcado como finalizado.`)) return;
    setBusy(draft.id);
    try {
      await AssessmentContract.update(draft.id, { status: 'active' });

      if (parent) {
        await AssessmentContract.update(parent.id, { status: 'finished' });
      }

      await AssessmentContractEvent.create({
        contract_id: draft.id,
        event_type:  'renewal_activated',
        payload: {
          parent_contract_id:     parent?.id || null,
          parent_contract_number: parent?.contract_number || null,
        },
        notes: 'Rascunho de renovação aprovado e ativado',
      }).catch(() => {});

      toast.success(`Renovação ${draft.contract_number} ativada!`);
      load();
    } catch (e) {
      toast.error('Erro ao ativar: ' + (e.message || ''));
    } finally {
      setBusy(null);
    }
  };

  const discardRenewal = async (draft, parent) => {
    if (!confirm(`Descartar a renovação ${draft.contract_number}?\n\nO rascunho será excluído e o contrato anterior voltará a ser elegível para nova renovação.`)) return;
    setBusy(draft.id);
    try {
      await AssessmentContract.delete(draft.id);

      if (parent) {
        await AssessmentContract.update(parent.id, { renewal_generated: false });
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

  const declineRenewal = async (draft, parent) => {
    if (!parent) return toast.error('Contrato anterior não encontrado');
    const shouldFinishNow = parent.end_date <= todayLocalStr();
    const statusText = shouldFinishNow
      ? 'O contrato anterior será concluído agora.'
      : `O contrato anterior fica ativo até ${formatDate(parent.end_date)} e será concluído sem renovação.`;
    if (!confirm(
      `Registrar que ${draft.contract_number} não será renovado?\n\n` +
      `O rascunho será excluído. ${statusText}\n\n` +
      'Não haverá multa, estorno ou cobrança nova.'
    )) return;

    setBusy(draft.id);
    try {
      await AssessmentContract.update(parent.id, {
        renewal_generated: true,
        cancellation_date: parent.end_date,
        cancellation_fee: 0,
        cancellation_reason: 'Não renovou',
        refund_status: null,
        refund_amount: null,
        ...(shouldFinishNow ? { status: 'finished' } : {}),
      });
      await AssessmentContract.delete(draft.id);
      await AssessmentContractEvent.create({
        contract_id: parent.id,
        event_type:  'renewal_declined',
        payload: {
          discarded_draft_id:     draft.id,
          discarded_draft_number: draft.contract_number,
          effective_end_date:     parent.end_date,
          status_after:           shouldFinishNow ? 'finished' : parent.status,
          no_financial_penalty:   true,
        },
        notes: 'Aluno não vai renovar. Encerramento sem multa, estorno ou nova cobrança.',
      }).catch(() => {});

      toast.success('Não renovação registrada sem multa ou estorno.');
      load();
    } catch (e) {
      toast.error('Erro ao registrar não renovação: ' + (e.message || ''));
    } finally {
      setBusy(null);
    }
  };

  // ── Scan de renovações ───────────────────────────────────────────────────

  const runScan = async () => {
    setScanning(true);
    setScanResult(null);
    try {
      const { data, error } = await supabase.functions.invoke('prepare-renewals', {
        body: { horizon_days: normalizeScanDays(scanForm.horizon_days) },
      });
      if (error) {
        let msg = error.message;
        try {
          if (error.context?.json) { const b = await error.context.json(); if (b?.error) msg = b.error; }
        } catch { /**/ }
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

  const orderedDrafts = useMemo(
    () => [...drafts].sort((a, b) => compareRenewalDrafts(a, b, parents)),
    [drafts, parents]
  );
  const totalValue = orderedDrafts.reduce((s, d) => s + contractTotal(d), 0);
  const todayStr = todayLocalStr();
  const scanWindowDays = normalizeScanDays(scanForm.horizon_days);
  const scanWindowEnd = addDays(todayStr, scanWindowDays);
  const firstDraft = orderedDrafts[0];
  const firstDraftDaysLeft = firstDraft
    ? renewalDaysLeft(firstDraft, parents[firstDraft.parent_contract_id], todayStr)
    : null;

  // ─────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Cabeçalho */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <RefreshCcw className="w-5 h-5 text-blue-600" />
            Renovações
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Rascunhos gerados automaticamente aguardando aprovação
          </p>
        </div>
        <Button onClick={() => setScanModal(true)} variant="outline">
          <RotateCcw className="w-4 h-4 mr-1.5" />
          Verificar renovações agora
        </Button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-full bg-blue-50 shrink-0"><RefreshCcw className="w-5 h-5 text-blue-600" /></div>
            <div>
              <p className="text-xs text-muted-foreground">Pendentes</p>
              <p className="text-xl font-bold text-blue-700">{orderedDrafts.length}</p>
              {firstDraft && (
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Próxima: {renewalTimingLabel(firstDraftDaysLeft).toLowerCase()}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-full bg-gray-50 shrink-0"><Activity className="w-5 h-5 text-gray-600" /></div>
            <div>
              <p className="text-xs text-muted-foreground">Valor potencial</p>
              <p className="text-xl font-bold text-gray-800">{formatCurrency(totalValue)}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 gap-3 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Carregando...</span>
        </div>
      ) : orderedDrafts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16 text-center">
            <CheckCheck className="w-10 h-10 text-green-500 mb-3" />
            <p className="text-base font-semibold text-gray-700">Nenhuma renovação pendente</p>
            <p className="text-sm text-muted-foreground mt-1">
              Contratos próximos do vencimento geram rascunhos automaticamente aqui.
            </p>
            <Button className="mt-4" variant="outline" onClick={() => setScanModal(true)}>
              <RotateCcw className="w-4 h-4 mr-1.5" /> Verificar agora
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {orderedDrafts.map(draft => (
            <RenewalRow
              key={draft.id}
              draft={draft}
              parent={parents[draft.parent_contract_id]}
              customer={customers[draft.customer_id]}
              coach={coaches[draft.coach_id]}
              modality={modalities[draft.plan_snapshot?.modality_id]}
              onActivate={activateRenewal}
              onDecline={declineRenewal}
              onDiscard={discardRenewal}
              busy={busy === draft.id}
            />
          ))}
        </div>
      )}

      {/* Modal: scan de renovações */}
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
              <Label>Janela de renovação</Label>
              <Input
                type="number" min="1" max="90"
                className="mt-1"
                value={scanForm.horizon_days}
                onChange={e => setScanForm(f => ({ ...f, horizon_days: e.target.value }))}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Padrão do sistema: {RENEWAL_ATTENTION_WINDOW_DAYS} dias antes do vencimento.
              </p>
            </div>
            <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-3 text-xs text-blue-900 space-y-1">
              <p>
                Com <b>{scanWindowDays} dia{scanWindowDays === 1 ? '' : 's'}</b>, serão considerados contratos que vencem de <b>{formatDate(todayStr)}</b> até <b>{formatDate(scanWindowEnd)}</b>.
              </p>
              <p className="text-blue-700">
                Depois de criados, os rascunhos aparecem do menor prazo para o maior prazo.
              </p>
            </div>

            {scanResult && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm space-y-1">
                <p><b>Contratos verificados:</b> {scanResult.processed}</p>
                <p className="text-green-700"><b>Rascunhos criados:</b> {scanResult.drafts_created}</p>
                {scanResult.errors?.length > 0 && (
                  <p className="text-red-700"><b>Erros:</b> {scanResult.errors.length}</p>
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

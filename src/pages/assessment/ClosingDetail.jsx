import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft, CheckCircle2, User, Plus, Minus, Receipt, ChevronDown, ChevronRight, Printer,
  Lock, Banknote, Info, AlertTriangle, RotateCcw, Trash2,
} from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  PayoutMonthlyClosing, PayoutMonthlyStatementItem, AssessmentCoach,
} from '@/api/entities';
import { supabase } from '@/api/db';
import {
  createPayoutAdjustment,
  deletePayoutAdjustment,
  transitionPayoutClosing,
} from '@/api/client';
import { formatCurrency, formatDate, formatCompetence, todayLocalStr } from '@/lib/utils';
import { monthHasEnded, monthOpensOn } from '@/lib/closing-months';
import { functionErrorMessage } from '@/lib/function-error';
import {
  EXPENSE_CATEGORIES, MANUAL_ENTRY_KINDS, expenseCategoryLabel, manualEntryKind, signedManualAmount,
} from '@/lib/payout-expenses';
import { toast } from 'sonner';

const SOURCE = {
  athlete_repasse:    { label: 'Repasse atleta',    cls: 'bg-blue-100 text-blue-700' },
  direct_leadership:  { label: 'Liderança',         cls: 'bg-purple-100 text-purple-700' },
  co_leadership:      { label: 'Co-liderança',      cls: 'bg-indigo-100 text-indigo-700' },
};

// Lançamentos manuais (source_type manual_adjustment), pelo tipo.
const MANUAL_KIND = {
  repasse_extra: {
    label: 'Repasse extra', cls: 'bg-emerald-100 text-emerald-700', Icon: Plus,
    hint: 'Soma ao repasse do coach. Use para o que o cálculo automático não pegou, como dias de um plano anterior.',
    placeholder: 'Ex.: dias 01 a 09/09 do plano anterior do aluno (sistema antigo)',
  },
  desconto: {
    label: 'Desconto', cls: 'bg-red-100 text-red-700', Icon: Minus,
    hint: 'Tira do repasse do coach. O valor não é repassado neste fechamento.',
    placeholder: 'Ex.: aula do dia 12/09 não foi dada',
  },
  gasto: {
    label: 'Gasto / reembolso', cls: 'bg-amber-100 text-amber-700', Icon: Receipt,
    hint: 'Combustível, insumos, escalas e outros gastos do coach.',
    placeholder: 'Ex.: reembolso da gasolina do treino de sábado',
  },
};

const EMPTY_ENTRY = {
  kind: 'repasse_extra', coach_id: '', category: 'reembolso_combustivel', amount: '', description: '', adjustment_reason: '',
};

const STATUS = {
  pending_approval: { label: 'Em revisão',  cls: 'bg-amber-100 text-amber-700' },
  approved:         { label: 'Aprovado',    cls: 'bg-blue-100 text-blue-700' },
  paid:             { label: 'Pago',        cls: 'bg-green-100 text-green-700' },
};

export default function ClosingDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [closing, setClosing]   = useState(null);
  const [items, setItems]       = useState([]);
  const [coaches, setCoaches]   = useState([]);
  const [expanded, setExpanded] = useState({}); // coach_id → bool
  const [expandedItem, setExpandedItem] = useState({}); // item_id → bool
  const [adjustModal, setAdjustModal] = useState(false);
  const [adjustForm, setAdjustForm] = useState(EMPTY_ENTRY);
  const [savingAdjust, setSavingAdjust] = useState(false);
  const [approving, setApproving] = useState(false);
  const [markingPaid, setMarkingPaid] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [recalculating, setRecalculating] = useState(false);
  const [pendings, setPendings] = useState([]);
  const [pendingContracts, setPendingContracts] = useState([]);

  const load = async () => {
    try {
      const [c, i, co] = await Promise.all([
        PayoutMonthlyClosing.get(id),
        PayoutMonthlyStatementItem.filter({ closing_id: id }).catch(() => []),
        AssessmentCoach.list('name').catch(() => []),
      ]);
      setClosing(c); setItems(i); setCoaches(co);

      // Pendências (repasse aguardando pagamento do aluno) detectadas neste fechamento
      const { data: pend } = await supabase
        .from('payout_pending_repasse')
        .select('*')
        .eq('detected_in_closing_id', id)
        .eq('status', 'open');
      setPendings(pend || []);
      const cids = [...new Set((pend || []).map(p => p.contract_id))];
      if (cids.length) {
        const { data: cts } = await supabase
          .from('assessment_contracts').select('id, due_date').in('id', cids);
        setPendingContracts(cts || []);
      } else {
        setPendingContracts([]);
      }
    } catch (e) {
      console.error('Erro ao carregar fechamento:', e);
    }
  };
  useEffect(() => { load(); }, [id]);

  // Agrupa por coach
  const grouped = coaches.map(coach => {
    const list = items.filter(i => i.coach_id === coach.id);
    const subtotal = list.reduce((s, i) => s + Number(i.amount), 0);
    return { coach, items: list, subtotal };
  }).filter(g => g.items.length > 0).sort((a, b) => b.subtotal - a.subtotal);

  const total = items.reduce((s, i) => s + Number(i.amount), 0);
  const adjustmentsTotal = items
    .filter(i => i.source_type === 'manual_adjustment')
    .reduce((s, i) => s + Number(i.amount), 0);

  // Carry-forward: itens resgatados de meses anteriores (reference != competência atual)
  const competence = closing?.competence;
  const isCarried = (it) => !!it.reference_competence && !!competence && it.reference_competence !== competence;
  const refLabel = (ref) => formatCompetence(ref, { short: true });
  // Pendências (aguardando pagamento) — não somam ao total a pagar
  const todayStr = new Date().toISOString().slice(0, 10);
  const dueByContract = Object.fromEntries(pendingContracts.map(c => [c.id, c.due_date]));
  const pendingTotal = pendings.reduce((s, p) => s + Number(p.amount), 0);
  const pendingByCoach = coaches.map(coach => {
    const list = pendings.filter(p => p.coach_id === coach.id);
    const subtotal = list.reduce((s, p) => s + Number(p.amount), 0);
    return { coach, list, subtotal };
  }).filter(g => g.list.length > 0).sort((a, b) => b.subtotal - a.subtotal);

  const approve = async () => {
    if (!confirm('Aprovar fechamento?\n\nOs valores ficam congelados e coaches passam a visualizar o extrato. Você ainda pode reabrir se precisar ajustar.')) return;
    setApproving(true);
    try {
      await transitionPayoutClosing(id, 'approve');
      toast.success('Fechamento aprovado e congelado!'); load();
    } catch (e) { toast.error(e.message); }
    finally { setApproving(false); }
  };

  const markAsPaid = async () => {
    if (!confirm('Marcar como pago?\n\nIndica que os repasses foram efetivados. Após isso, o fechamento fica permanentemente bloqueado para edição.')) return;
    setMarkingPaid(true);
    try {
      await transitionPayoutClosing(id, 'pay');
      toast.success('Fechamento marcado como pago!'); load();
    } catch (e) { toast.error(e.message); }
    finally { setMarkingPaid(false); }
  };

  const reopen = async () => {
    if (!confirm('Reabrir fechamento aprovado?\n\nVolta para "em revisão" e libera novamente para edição. Use apenas se precisar corrigir algo antes do pagamento.')) return;
    setReopening(true);
    try {
      await transitionPayoutClosing(id, 'reopen');
      toast.success('Fechamento reaberto para edição'); load();
    } catch (e) { toast.error(e.message); }
    finally { setReopening(false); }
  };

  const recalculate = async () => {
    if (!confirm('Recalcular este fechamento?\n\nOs itens automáticos são regerados a partir dos contratos pagos de agora. Repasses extras, descontos e gastos lançados à mão são preservados.')) return;
    setRecalculating(true);
    try {
      const { data, error } = await supabase.functions.invoke('generate-monthly-closing', {
        body: { competence: closing.competence, regenerate: true },
      });
      if (error) throw new Error(await functionErrorMessage(error, 'Erro ao recalcular'));
      if (data?.error) throw new Error(data.error);
      toast.success(`Fechamento recalculado! ${data.items_count} itens · total ${formatCurrency(data.total_amount)}`);
      load();
    } catch (e) { toast.error(e.message || 'Erro ao recalcular'); }
    finally { setRecalculating(false); }
  };

  const openEntry = (kind) => {
    setAdjustForm({ ...EMPTY_ENTRY, kind });
    setAdjustModal(true);
  };

  const addAdjust = async () => {
    const { kind } = adjustForm;
    const value = Math.round(Number(adjustForm.amount) * 100) / 100;
    if (!adjustForm.coach_id) return toast.error('Selecione o coach');
    if (!Number.isFinite(value) || value <= 0) return toast.error('Informe um valor maior que zero');
    if (!adjustForm.adjustment_reason?.trim()) return toast.error('Escreva a explicação do lançamento');
    const category = kind === 'gasto' ? (adjustForm.category || 'outros') : kind;
    setSavingAdjust(true);
    try {
      await createPayoutAdjustment(id, {
        coach_id:    adjustForm.coach_id,
        expense_category: category,
        description: (kind === 'gasto' && adjustForm.description?.trim()) || expenseCategoryLabel(category),
        amount:      signedManualAmount(kind, value),
        adjustment_reason: adjustForm.adjustment_reason.trim(),
      });
      toast.success(`${MANUAL_KIND[kind].label} lançado no extrato!`);
      setAdjustModal(false);
      setAdjustForm(EMPTY_ENTRY);
      load();
    } catch (e) { toast.error(e.message); }
    finally { setSavingAdjust(false); }
  };

  const removeAdjust = async (item) => {
    const label = MANUAL_KIND[manualEntryKind(item.expense_category)].label;
    if (!confirm(`Remover ${label.toLowerCase()} de ${formatCurrency(item.amount)}?`)) return;
    try {
      await deletePayoutAdjustment(id, item.id);
      toast.success('Lançamento removido'); load();
    } catch (e) {
      // Mensagem do trigger é amigável
      toast.error(e.message?.replace(/^.*Não/, 'Não') || 'Erro ao remover');
    }
  };

  if (!closing) return <div className="p-8 text-center text-muted-foreground">Carregando...</div>;

  const st = STATUS[closing.status] || {};
  const competenceLabel = formatCompetence(closing.competence);
  const isLocked = closing.status === 'approved' || closing.status === 'paid';
  const isDraft  = closing.status === 'pending_approval';
  const isPaid   = closing.status === 'paid';
  // Fechamento de mês que ainda não terminou não recalcula nem aprova (trava
  // também na função e no banco).
  const monthOpen = !monthHasEnded(closing.competence, todayLocalStr());

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="ghost" size="icon" onClick={() => navigate('/assessoria/fechamento')}><ArrowLeft className="w-4 h-4" /></Button>
        <div>
          <h2 className="text-xl font-bold">Fechamento {competenceLabel}</h2>
          <p className="text-sm text-muted-foreground">
            Gerado em {formatDate(closing.generated_at?.split('T')[0])}
            {closing.approved_at && <> · Aprovado em {formatDate(closing.approved_at?.split('T')[0])}</>}
            {closing.paid_at && <> · Pago em {formatDate(closing.paid_at?.split('T')[0])}</>}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${st.cls}`}>{st.label}</span>
          {isLocked && (
            <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
              <Lock className="w-3 h-3" /> Imutável
            </span>
          )}
          {isDraft && monthOpen && (
            <span className="text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-full px-2.5 py-1">
              Mês em andamento: recalcular e aprovar a partir de {formatDate(monthOpensOn(closing.competence))}
            </span>
          )}
          {isDraft && !monthOpen && (
            <>
              <Button onClick={recalculate} disabled={recalculating || approving} variant="outline" size="sm">
                <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> {recalculating ? 'Recalculando...' : 'Recalcular'}
              </Button>
              <Button onClick={approve} disabled={approving || recalculating} className="bg-green-600 hover:bg-green-700">
                <CheckCircle2 className="w-4 h-4 mr-1.5" /> {approving ? 'Aprovando...' : 'Aprovar'}
              </Button>
            </>
          )}
          {closing.status === 'approved' && (
            <>
              <Button onClick={reopen} variant="outline" size="sm" disabled={reopening}>
                <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> {reopening ? 'Reabrindo...' : 'Reabrir'}
              </Button>
              <Button onClick={markAsPaid} disabled={markingPaid} className="bg-blue-600 hover:bg-blue-700">
                <Banknote className="w-4 h-4 mr-1.5" /> {markingPaid ? 'Salvando...' : 'Marcar como pago'}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Banner imutabilidade */}
      {isLocked && (
        <div className={`rounded-xl border px-4 py-3 flex items-start gap-3 ${
          isPaid ? 'bg-green-50 border-green-200' : 'bg-blue-50 border-blue-200'
        }`}>
          {isPaid ? <Banknote className="w-5 h-5 text-green-700 shrink-0 mt-0.5" />
                  : <Lock className="w-5 h-5 text-blue-700 shrink-0 mt-0.5" />}
          <div className="text-sm">
            <p className={`font-semibold ${isPaid ? 'text-green-900' : 'text-blue-900'}`}>
              {isPaid ? 'Fechamento pago e finalizado' : 'Fechamento aprovado'}
            </p>
            <p className={isPaid ? 'text-green-700 text-xs' : 'text-blue-700 text-xs'}>
              {isPaid
                ? 'Os repasses foram efetivados. Este fechamento é permanente e não pode ser alterado.'
                : 'Os valores estão congelados. Reabra para fazer ajustes antes do pagamento.'}
            </p>
          </div>
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Total a pagar</p>
          <p className="text-2xl font-bold text-green-600">{formatCurrency(total)}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Automático {formatCurrency(total - adjustmentsTotal)}
            {adjustmentsTotal !== 0 && ` · lançamentos ${adjustmentsTotal >= 0 ? '+' : ''}${formatCurrency(adjustmentsTotal)}`}
          </p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Coaches</p>
          <p className="text-2xl font-bold">{grouped.length}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">com repasse neste mês</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Itens calculados</p>
          <p className="text-2xl font-bold">{items.filter(i => i.source_type !== 'manual_adjustment').length}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">alunos/bônus processados</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Lançamentos manuais</p>
          <p className={`text-2xl font-bold ${adjustmentsTotal > 0 ? 'text-amber-700' : adjustmentsTotal < 0 ? 'text-red-700' : 'text-gray-400'}`}>
            {adjustmentsTotal !== 0 ? `${adjustmentsTotal > 0 ? '+' : ''}${formatCurrency(adjustmentsTotal)}` : '—'}
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {items.filter(i => i.source_type === 'manual_adjustment').length} lançamento(s)
          </p>
        </CardContent></Card>
      </div>

      {/* Legenda de tipos */}
      <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
        <span className="font-medium text-gray-700">Tipos de item:</span>
        {[...Object.entries(SOURCE), ...Object.entries(MANUAL_KIND)].map(([k, v]) => (
          <span key={k} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-semibold ${v.cls}`}>
            {v.label}
          </span>
        ))}
      </div>

      {isDraft && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => openEntry('repasse_extra')}
            className="text-emerald-700 border-emerald-200 hover:bg-emerald-50 hover:text-emerald-800">
            <Plus className="w-3.5 h-3.5 mr-1" /> Repasse extra
          </Button>
          <Button size="sm" variant="outline" onClick={() => openEntry('desconto')}
            className="text-red-700 border-red-200 hover:bg-red-50 hover:text-red-800">
            <Minus className="w-3.5 h-3.5 mr-1" /> Desconto
          </Button>
          <Button size="sm" variant="outline" onClick={() => openEntry('gasto')}>
            <Receipt className="w-3.5 h-3.5 mr-1" /> Gasto / reembolso
          </Button>
        </div>
      )}

      {/* Tabela por coach */}
      {grouped.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-muted-foreground">Nenhum item no fechamento</CardContent></Card>
      ) : (
        <div className="space-y-2">
          {grouped.map(({ coach, items: list, subtotal }) => {
            const isOpen = expanded[coach.id];
            return (
              <Card key={coach.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-2">
                    <button onClick={() => setExpanded(e => ({ ...e, [coach.id]: !e[coach.id] }))} className="flex items-center gap-2 text-left flex-1 min-w-0">
                      {isOpen ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
                      <User className="w-4 h-4 text-blue-600 shrink-0" />
                      <span className="font-bold truncate">{coach.name}</span>
                      <span className="text-xs text-muted-foreground capitalize shrink-0">({coach.role})</span>
                      <span className="text-xs text-muted-foreground shrink-0">· {list.length} {list.length === 1 ? 'item' : 'itens'}</span>
                    </button>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-lg font-bold text-green-600">{formatCurrency(subtotal)}</span>
                      <Link to={`/assessoria/fechamento/${id}/extrato/${coach.id}`} className="flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800 hover:underline" title="Extrato para enviar ao treinador">
                        <Printer className="w-3.5 h-3.5" /> Extrato
                      </Link>
                    </div>
                  </div>
                </CardHeader>
                {isOpen && (
                  <CardContent className="pt-0">
                    <div className="divide-y border-t">
                      {list.map(it => {
                        const isManual = it.source_type === 'manual_adjustment';
                        const kind = isManual ? manualEntryKind(it.expense_category) : null;
                        const so = isManual ? MANUAL_KIND[kind] : (SOURCE[it.source_type] || { label: it.source_type, cls: '' });
                        // Lançamento manual: a explicação é o texto da linha, a não ser que a
                        // descrição diga algo além do tipo/categoria.
                        const explainsItself = isManual && !!it.adjustment_reason
                          && (!it.description || it.description === expenseCategoryLabel(it.expense_category));
                        const itemOpen = expandedItem[it.id];
                        const hasSnapshot = it.rate_applied != null || it.tier_applied != null || it.base_value != null;
                        return (
                          <div key={it.id} className="py-2.5">
                            <div className="flex items-center gap-2">
                              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 ${so.cls}`}>{so.label}</span>
                              {isCarried(it) && (
                                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 bg-orange-100 text-orange-700" title="Resgatado de mês anterior">
                                  ref. {refLabel(it.reference_competence)}
                                </span>
                              )}
                              {isManual && kind === 'gasto' && it.expense_category && (
                                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 bg-amber-50 text-amber-700 border border-amber-200" title="Categoria do gasto/reembolso">
                                  {expenseCategoryLabel(it.expense_category)}
                                </span>
                              )}
                              <div className="flex-1 min-w-0">
                                <p className={`text-sm ${explainsItself ? 'break-words' : 'truncate'}`}>
                                  {explainsItself ? it.adjustment_reason : it.description}
                                </p>
                                {it.valid_days != null && (
                                  <p className="text-[11px] text-muted-foreground">
                                    {it.valid_days}/{it.month_days} dias
                                    {it.prorata_factor != null && ` · pró-rata ${(Number(it.prorata_factor) * 100).toFixed(0)}%`}
                                  </p>
                                )}
                              </div>
                              <span className={`font-semibold shrink-0 text-sm ${Number(it.amount) < 0 ? 'text-red-700' : ''}`}>
                                {formatCurrency(it.amount)}
                              </span>
                              {hasSnapshot && (
                                <button
                                  onClick={() => setExpandedItem(e => ({ ...e, [it.id]: !e[it.id] }))}
                                  className="text-muted-foreground hover:text-gray-700 p-0.5"
                                  title="Ver detalhes do cálculo"
                                >
                                  <Info className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {isManual && isDraft && (
                                <button
                                  onClick={() => removeAdjust(it)}
                                  className="text-red-500 hover:bg-red-50 p-1 rounded"
                                  title="Remover lançamento"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                            {itemOpen && hasSnapshot && (
                              <div className="mt-2 ml-12 bg-gray-50 border rounded-lg p-2.5 text-xs space-y-1">
                                {it.base_value != null && (
                                  <div className="flex justify-between">
                                    <span className="text-muted-foreground">Valor base</span>
                                    <span className="font-medium">{formatCurrency(it.base_value)}</span>
                                  </div>
                                )}
                                {it.rate_applied != null && (
                                  <div className="flex justify-between">
                                    <span className="text-muted-foreground">Valor aplicado</span>
                                    <span className="font-medium">{formatCurrency(it.rate_applied)}</span>
                                  </div>
                                )}
                                {it.prorata_factor != null && (
                                  <div className="flex justify-between">
                                    <span className="text-muted-foreground">× pró-rata</span>
                                    <span className="font-medium">{(Number(it.prorata_factor) * 100).toFixed(2)}%</span>
                                  </div>
                                )}
                                {it.tier_applied && (
                                  <div className="border-t pt-1 mt-1">
                                    <div className="flex justify-between">
                                      <span className="text-muted-foreground">Tier aplicado</span>
                                      <span className="font-medium">{it.tier_applied.name || '—'}</span>
                                    </div>
                                    {it.tier_applied.total_active_at_close != null && (
                                      <div className="flex justify-between text-[11px]">
                                        <span className="text-muted-foreground">Total atletas no fechamento</span>
                                        <span>{it.tier_applied.total_active_at_close}</span>
                                      </div>
                                    )}
                                    {Number(it.tier_applied.increment_per_athlete) > 0 && (
                                      <div className="flex justify-between text-[11px]">
                                        <span className="text-muted-foreground">+ Incremento por atleta</span>
                                        <span>{formatCurrency(it.tier_applied.increment_per_athlete)}</span>
                                      </div>
                                    )}
                                  </div>
                                )}
                                {it.leadership_bonus > 0 && (
                                  <div className="flex justify-between border-t pt-1 mt-1">
                                    <span className="text-muted-foreground">Bônus liderança</span>
                                    <span className="font-medium">{formatCurrency(it.leadership_bonus)}</span>
                                  </div>
                                )}
                                {it.adjustment_reason && (
                                  <div className="border-t pt-1 mt-1">
                                    <span className="text-muted-foreground">Motivo do ajuste:</span>
                                    <p className="text-gray-700 italic">"{it.adjustment_reason}"</p>
                                  </div>
                                )}
                              </div>
                            )}
                            {/* Lançamento com descrição própria: explicação resumida embaixo */}
                            {isManual && !explainsItself && it.adjustment_reason && !itemOpen && (
                              <p className="ml-12 mt-0.5 text-[11px] text-amber-700 italic truncate">
                                "{it.adjustment_reason}"
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* Aguardando pagamento (pendências) */}
      {pendings.length > 0 && (
        <Card className="border-amber-200">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
                <span className="font-semibold text-amber-900">Aguardando pagamento</span>
                <span className="text-xs text-muted-foreground">
                  {pendings.length} {pendings.length === 1 ? 'pendência' : 'pendências'} · não entram no total
                </span>
              </div>
              <span className="text-sm font-bold text-amber-700">{formatCurrency(pendingTotal)}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Alunos que ainda não pagaram este mês. Quando pagarem, o repasse entra automaticamente no fechamento do mês do pagamento, carimbado com a referência deste mês.
            </p>
          </CardHeader>
          <CardContent className="pt-0 space-y-3">
            {pendingByCoach.map(({ coach, list, subtotal }) => (
              <div key={coach.id} className="border-t pt-2">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <User className="w-3.5 h-3.5 text-amber-600" />
                    <span className="font-semibold text-sm">{coach.name}</span>
                    <span className="text-xs text-muted-foreground capitalize">({coach.role})</span>
                  </div>
                  <span className="text-sm font-semibold text-amber-700">{formatCurrency(subtotal)}</span>
                </div>
                <div className="divide-y">
                  {list.map(p => {
                    const due = dueByContract[p.contract_id];
                    const overdue = due && due < todayStr;
                    return (
                      <div key={p.id} className="flex items-center gap-2 py-1.5">
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 ${(SOURCE[p.source_type] || {}).cls || 'bg-gray-100 text-gray-600'}`}>
                          {(SOURCE[p.source_type] || {}).label || p.source_type}
                        </span>
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 ${overdue ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'}`}>
                          {overdue ? 'vencido' : 'a vencer'}
                        </span>
                        <p className="text-sm truncate flex-1 min-w-0">{p.description}</p>
                        <span className="text-sm font-medium text-muted-foreground shrink-0">{formatCurrency(p.amount)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Lançamento manual: repasse extra, desconto ou gasto/reembolso */}
      <Dialog open={adjustModal} onOpenChange={open => !open && !savingAdjust && setAdjustModal(false)}>
        <DialogContent className="max-w-md">
          {(() => {
            const kind = MANUAL_KIND[adjustForm.kind];
            const KindIcon = kind.Icon;
            const value = Number(adjustForm.amount);
            const coachGroup = grouped.find(g => g.coach.id === adjustForm.coach_id);
            const coachName = coaches.find(c => c.id === adjustForm.coach_id)?.name;
            const current = coachGroup?.subtotal ?? 0;
            const after = current + (Number.isFinite(value) && value > 0 ? signedManualAmount(adjustForm.kind, value) : 0);
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <KindIcon className={`w-5 h-5 ${adjustForm.kind === 'desconto' ? 'text-red-600' : adjustForm.kind === 'repasse_extra' ? 'text-emerald-600' : 'text-amber-600'}`} />
                    {kind.label}
                  </DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-1 rounded-lg bg-gray-100 p-1" role="radiogroup" aria-label="Tipo do lançamento">
                    {MANUAL_ENTRY_KINDS.map(k => (
                      <button
                        key={k.value}
                        type="button"
                        role="radio"
                        aria-checked={adjustForm.kind === k.value}
                        onClick={() => setAdjustForm(f => ({ ...f, kind: k.value }))}
                        className={`rounded-md px-2 py-1.5 text-xs font-semibold transition-colors ${
                          adjustForm.kind === k.value ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-800'
                        }`}
                      >
                        {k.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-start gap-2 bg-gray-50 border rounded-lg p-2.5 text-xs text-gray-700">
                    <Info className="w-4 h-4 shrink-0 mt-0.5 text-gray-500" />
                    <span>{kind.hint} Entra como item separado no extrato do coach; o cálculo automático não muda.</span>
                  </div>
                  <div>
                    <Label>Coach *</Label>
                    <Select value={adjustForm.coach_id} onValueChange={v => setAdjustForm(f => ({ ...f, coach_id: v }))}>
                      <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione" /></SelectTrigger>
                      <SelectContent>
                        {coaches.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  {adjustForm.kind === 'gasto' && (
                    <div>
                      <Label>Categoria *</Label>
                      <Select value={adjustForm.category} onValueChange={v => setAdjustForm(f => ({ ...f, category: v }))}>
                        <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione" /></SelectTrigger>
                        <SelectContent>
                          {EXPENSE_CATEGORIES.map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <div>
                    <Label>{adjustForm.kind === 'desconto' ? 'Valor a descontar (R$) *' : 'Valor (R$) *'}</Label>
                    <Input className="mt-1" type="number" step="0.01" min="0.01" inputMode="decimal"
                      value={adjustForm.amount}
                      onChange={e => setAdjustForm(f => ({ ...f, amount: e.target.value }))}
                      placeholder="0,00"
                    />
                  </div>
                  <div>
                    <Label>Explicação *</Label>
                    <Textarea rows={2} className="mt-1"
                      value={adjustForm.adjustment_reason}
                      onChange={e => setAdjustForm(f => ({ ...f, adjustment_reason: e.target.value }))}
                      placeholder={kind.placeholder}
                    />
                    <p className="text-[11px] text-muted-foreground mt-1">Aparece no extrato do coach.</p>
                  </div>
                  {adjustForm.kind === 'gasto' && (
                    <div>
                      <Label>Descrição (curta)</Label>
                      <Input className="mt-1"
                        value={adjustForm.description}
                        onChange={e => setAdjustForm(f => ({ ...f, description: e.target.value }))}
                        placeholder="Resumo que aparece no extrato"
                      />
                    </div>
                  )}
                  {coachName && Number.isFinite(value) && value > 0 && (
                    <div className={`rounded-lg border px-3 py-2 text-xs ${after < 0 ? 'bg-red-50 border-red-200 text-red-800' : 'bg-gray-50 text-gray-700'}`}>
                      Extrato de {coachName}: {formatCurrency(current)} → <b>{formatCurrency(after)}</b>
                      {after < 0 && <span className="block mt-0.5">O extrato fica negativo.</span>}
                    </div>
                  )}
                  <div className="flex gap-2 pt-1">
                    <Button variant="outline" className="flex-1" onClick={() => setAdjustModal(false)} disabled={savingAdjust}>
                      Cancelar
                    </Button>
                    <Button
                      className={`flex-1 ${adjustForm.kind === 'desconto' ? 'bg-red-600 hover:bg-red-700' : adjustForm.kind === 'repasse_extra' ? 'bg-emerald-600 hover:bg-emerald-700' : ''}`}
                      onClick={addAdjust}
                      disabled={savingAdjust}
                    >
                      {savingAdjust ? 'Salvando...' : `Lançar ${kind.label.toLowerCase()}`}
                    </Button>
                  </div>
                </div>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}

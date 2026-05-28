import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, FileText, Save, Check, ChevronRight, Users, Calendar, RotateCcw, BadgeDollarSign, Plus, UserPlus } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import {
  AssessmentContract, PreSaleCustomer, AssessmentCoach, AssessmentPlan, AssessmentModality,
} from '@/api/entities';
import { formatCurrency, todayLocalStr, toLocalDateStr } from '@/lib/utils';
import DiscountInput from '@/components/DiscountInput';
import { toast } from 'sonner';

function computeEndDate(startStr, plan) {
  if (!startStr || !plan) return '';
  const d = new Date(startStr + 'T12:00:00');
  const months = plan.period_months
    || { mensal: 1, trimestral: 3, semestral: 6, anual: 12 }[plan.period]
    || 1;
  d.setMonth(d.getMonth() + months);
  return toLocalDateStr(d);
}

function getPlanMonths(plan) {
  return plan?.period_months
    || { mensal: 1, trimestral: 3, semestral: 6, anual: 12 }[plan?.period]
    || 1;
}

function planPeriodLabel(plan) {
  const m = getPlanMonths(plan);
  const names = { 1: '1 mês', 2: '2 meses', 3: '3 meses', 6: '6 meses', 12: '12 meses' };
  return names[m] || `${m} meses`;
}

// ─── Step 1: visual plan card ─────────────────────────────────────────────────
function PlanCard({ plan, modality, selected, onClick }) {
  const planName = plan.name?.trim() || `${modality?.name || 'Plano'} · ${planPeriodLabel(plan)}`;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left p-4 rounded-xl border-2 transition-all ${
        selected
          ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200'
          : 'border-gray-200 hover:border-blue-300 hover:bg-gray-50'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-blue-600 capitalize">{modality?.name || '—'}</p>
          <p className="font-bold text-gray-900 leading-tight mt-0.5">{planName}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{planPeriodLabel(plan)}</p>
        </div>
        {selected && (
          <div className="w-6 h-6 rounded-full bg-blue-500 flex items-center justify-center shrink-0">
            <Check className="w-3.5 h-3.5 text-white" />
          </div>
        )}
      </div>
      <div className="mt-3 space-y-1">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Mensal</span>
          <span className="font-semibold text-blue-700">{formatCurrency(plan.price_monthly)}/mês</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Total</span>
          <span className="font-semibold">{formatCurrency(plan.price_total)}</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Parcelas</span>
          <span className="text-gray-600">até {plan.max_installments}x</span>
        </div>
        {Number(plan.enrollment_fee) > 0 && (
          <div className="flex items-center justify-between text-xs pt-1 border-t">
            <span className="text-amber-700">Matrícula</span>
            <span className="font-semibold text-amber-700">{formatCurrency(plan.enrollment_fee)}</span>
          </div>
        )}
      </div>
    </button>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function ContractForm() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const preselectedId = searchParams.get('customer_id') || '';

  const [customers, setCustomers]     = useState([]);
  const [coaches, setCoaches]         = useState([]);
  const [plans, setPlans]             = useState([]);
  const [modalities, setModalities]   = useState([]);
  const [saving, setSaving]           = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');
  // Modal de cadastro rápido de aluno
  const [newCustomerModal, setNewCustomerModal] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ full_name: '', whatsapp: '', email: '', cpf: '' });
  const [creatingCustomer, setCreatingCustomer] = useState(false);

  // Step: 'plan' | 'details'
  const [step, setStep] = useState('plan');
  const [selectedPlan, setSelectedPlan] = useState(null);

  const [form, setForm] = useState({
    customer_id: preselectedId,
    coach_id: '',
    start_date: todayLocalStr(),
    installments: 1,
    notes: '',
    auto_renewal: false,
    enrollment_fee: 0,
    manual_discount: 0,
    discount_reason: '',
  });

  useEffect(() => {
    (async () => {
      try {
        const [s, co, p, m] = await Promise.all([
          PreSaleCustomer.list('full_name').catch(() => []),
          AssessmentCoach.filter({ active: true }, 'name').catch(() => []),
          AssessmentPlan.filter({ active: true }).catch(() => []),
          AssessmentModality.filter({ active: true }).catch(() => []),
        ]);
        setCustomers(s); setCoaches(co); setPlans(p); setModalities(m);
      } catch (e) {
        console.error('Erro ao carregar formulário:', e);
      }
    })();
  }, []);

  // Group plans by modality (só modalidades ativas + planos ativos)
  const plansByModality = modalities
    .filter(m => m.active !== false)
    .map(m => ({
      modality: m,
      plans: plans.filter(p => p.modality_id === m.id && p.active !== false),
    }))
    .filter(g => g.plans.length > 0);

  const filteredCustomers = customerSearch
    ? customers.filter(c => {
        const q = customerSearch.toLowerCase();
        const digits = customerSearch.replace(/\D/g, '');
        return c.full_name?.toLowerCase().includes(q) ||
               (digits && c.whatsapp?.includes(digits)) ||
               c.email?.toLowerCase().includes(q);
      }).slice(0, 50)
    : customers.slice(0, 50);

  const selectedCustomer = customers.find(c => c.id === form.customer_id);
  const endDate = selectedPlan ? computeEndDate(form.start_date, selectedPlan) : '';

  const pickPlan = (plan) => {
    setSelectedPlan(plan);
    // Default: parcelas = duração (mensal=1, trimestral=3, semestral=6…) limitado por max
    const months = getPlanMonths(plan);
    const defaultInstall = Math.min(months, plan.max_installments || months);
    setForm(f => ({
      ...f,
      installments:   defaultInstall,
      enrollment_fee: Number(plan.enrollment_fee) || 0,
    }));
  };

  const goToDetails = () => {
    if (!selectedPlan) return toast.error('Selecione um plano');
    setStep('details');
  };

  // Detecta se o termo digitado parece nome (sem dígitos) ou contato (com dígitos)
  const openNewCustomerModal = () => {
    const digits = customerSearch.replace(/\D/g, '');
    setNewCustomer({
      full_name: digits ? '' : customerSearch,
      whatsapp:  digits || '',
      email:     customerSearch.includes('@') ? customerSearch : '',
      cpf:       '',
    });
    setNewCustomerModal(true);
  };

  const saveNewCustomer = async () => {
    if (!newCustomer.full_name?.trim()) return toast.error('Nome obrigatório');
    setCreatingCustomer(true);
    try {
      const payload = {
        full_name: newCustomer.full_name.trim(),
        whatsapp:  newCustomer.whatsapp?.replace(/\D/g, '') || null,
        email:     newCustomer.email?.trim().toLowerCase() || null,
        cpf:       newCustomer.cpf?.replace(/\D/g, '') || null,
      };
      const created = await PreSaleCustomer.create(payload);
      // Adiciona à lista local e seleciona
      setCustomers(prev => [created, ...prev]);
      setForm(f => ({ ...f, customer_id: created.id }));
      setCustomerSearch('');
      setNewCustomerModal(false);
      setNewCustomer({ full_name: '', whatsapp: '', email: '', cpf: '' });
      toast.success(`${created.full_name} cadastrado!`);
    } catch (e) {
      // CPF unique constraint pode estourar aqui
      if (e.message?.includes('uniq_presale_customers_cpf')) {
        toast.error('Esse CPF já está cadastrado em outro cliente');
      } else {
        toast.error(e.message || 'Erro ao criar aluno');
      }
    } finally { setCreatingCustomer(false); }
  };

  const save = async () => {
    if (!form.customer_id) return toast.error('Selecione um aluno');
    if (!form.coach_id) return toast.error('Selecione um coach');
    if (!selectedPlan) return toast.error('Plano inválido');
    if (!form.start_date) return toast.error('Data de início obrigatória');

    const installments  = Math.min(Math.max(Number(form.installments) || 1, 1), selectedPlan.max_installments);
    const enrollmentFee = Math.max(Number(form.enrollment_fee) || 0, 0);
    const manualDiscount = Math.max(Number(form.manual_discount) || 0, 0);

    setSaving(true);
    try {
      const created = await AssessmentContract.create({
        customer_id:       form.customer_id,
        coach_id:          form.coach_id,
        plan_id:           selectedPlan.id,
        start_date:        form.start_date,
        end_date:          endDate,
        original_end_date: endDate,
        due_date:          endDate, // default; sobrescrito quando Asaas gera cobrança
        installments,
        enrollment_fee:    enrollmentFee,
        manual_discount:   manualDiscount,
        discount_reason:   form.discount_reason || null,
        auto_renewal:      !!form.auto_renewal,
        notes:             form.notes || null,
      });
      toast.success(`Contrato ${created.contract_number} criado!`);
      navigate(`/assessoria/contratos/${created.id}`);
    } catch (e) { toast.error(e.message || 'Erro ao criar contrato'); }
    finally { setSaving(false); }
  };

  // ── STEP 1: Selecionar plano ───────────────────────────────────────────────
  if (step === 'plan') {
    return (
      <div className="max-w-2xl mx-auto space-y-5">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/assessoria/contratos')}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div>
            <h2 className="text-xl font-bold">Novo contrato</h2>
            <p className="text-sm text-muted-foreground">Passo 1 de 2 — Escolha o plano</p>
          </div>
        </div>

        {plansByModality.length === 0 ? (
          <Card>
            <CardContent className="text-center py-12">
              <FileText className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">Nenhum plano ativo configurado.</p>
              <Button className="mt-4" variant="outline" onClick={() => navigate('/assessoria/configuracoes')}>
                Ir para Configurações
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            {plansByModality.map(({ modality, plans: mPlans }) => (
              <div key={modality.id}>
                <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-3 capitalize">
                  {modality.name}
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {mPlans.map(p => (
                    <PlanCard
                      key={p.id}
                      plan={p}
                      modality={modality}
                      selected={selectedPlan?.id === p.id}
                      onClick={() => pickPlan(p)}
                    />
                  ))}
                </div>
              </div>
            ))}

            <div className="flex justify-end pt-2">
              <Button onClick={goToDetails} disabled={!selectedPlan} size="lg">
                Próximo — Preencher detalhes <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </>
        )}
      </div>
    );
  }

  // ── STEP 2: Detalhes ───────────────────────────────────────────────────────
  const planModality = modalities.find(m => m.id === selectedPlan?.modality_id);

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => setStep('plan')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h2 className="text-xl font-bold">Novo contrato</h2>
          <p className="text-sm text-muted-foreground">Passo 2 de 2 — Detalhes</p>
        </div>
      </div>

      {/* Plano selecionado — resumo */}
      <div className="flex items-center gap-4 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
        <div className="flex-1">
          <p className="font-semibold text-blue-900">
            {selectedPlan?.name?.trim() || `${planModality?.name || 'Plano'} · ${planPeriodLabel(selectedPlan)}`}
          </p>
          <p className="text-xs text-blue-700 capitalize">{planModality?.name} · {planPeriodLabel(selectedPlan)}</p>
          <p className="text-sm text-blue-700">
            {formatCurrency(selectedPlan?.price_monthly)}/mês · total {formatCurrency(selectedPlan?.price_total)} · até {selectedPlan?.max_installments}x
            {Number(selectedPlan?.enrollment_fee) > 0 && (
              <span className="ml-1.5 text-amber-700 font-medium">· matrícula {formatCurrency(selectedPlan.enrollment_fee)}</span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setStep('plan')}
          className="text-xs text-blue-600 hover:underline shrink-0"
        >
          Trocar plano
        </button>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="w-4 h-4 text-blue-600" /> Aluno &amp; Coach
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Aluno *</Label>
            {selectedCustomer ? (
              <div className="flex items-center justify-between bg-blue-50 border border-blue-200 rounded-xl p-3 mt-1">
                <div className="min-w-0">
                  <p className="font-semibold truncate">{selectedCustomer.full_name}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {selectedCustomer.whatsapp || '—'}
                    {selectedCustomer.email && ` · ${selectedCustomer.email}`}
                  </p>
                </div>
                <button type="button"
                  onClick={() => setForm(f => ({ ...f, customer_id: '' }))}
                  className="text-xs text-blue-600 hover:underline shrink-0 ml-2">
                  Trocar
                </button>
              </div>
            ) : (
              <>
                <Input
                  placeholder="Digite para buscar nome, WhatsApp ou email..."
                  value={customerSearch}
                  onChange={e => setCustomerSearch(e.target.value)}
                  className="mt-1"
                  autoFocus
                />
                <div className="mt-2 max-h-60 overflow-y-auto rounded-lg border divide-y">
                  {filteredCustomers.length === 0 ? (
                    <div className="p-3 text-center">
                      <p className="text-sm text-muted-foreground mb-2">Nenhum aluno encontrado</p>
                      <button type="button"
                        onClick={openNewCustomerModal}
                        className="text-sm text-blue-600 hover:underline font-medium inline-flex items-center gap-1">
                        <Plus className="w-3.5 h-3.5" /> Cadastrar novo aluno
                        {customerSearch && <span className="text-xs text-muted-foreground">("{customerSearch}")</span>}
                      </button>
                    </div>
                  ) : filteredCustomers.map(c => (
                    <button key={c.id} type="button"
                      onClick={() => { setForm(f => ({ ...f, customer_id: c.id })); setCustomerSearch(''); }}
                      className="w-full text-left p-2.5 hover:bg-blue-50 transition-colors flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-sm">{c.full_name}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {c.whatsapp || c.email || '—'}
                        </p>
                      </div>
                      {!c.cpf && (
                        <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full shrink-0">
                          sem CPF
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                {/* Botão sempre visível pra cadastrar novo (mesmo quando tem resultados) */}
                {filteredCustomers.length > 0 && (
                  <button type="button"
                    onClick={openNewCustomerModal}
                    className="mt-2 w-full text-sm text-blue-600 hover:bg-blue-50 border border-dashed border-blue-200 rounded-lg py-2 inline-flex items-center justify-center gap-1 transition-colors">
                    <Plus className="w-3.5 h-3.5" /> Cadastrar novo aluno
                  </button>
                )}
                <p className="text-[11px] text-muted-foreground mt-1">
                  {customerSearch
                    ? `${filteredCustomers.length} resultado${filteredCustomers.length !== 1 ? 's' : ''}`
                    : `${customers.length} alunos · digite pra buscar`}
                </p>
              </>
            )}
            {selectedCustomer && !selectedCustomer.cpf && (
              <p className="text-xs text-amber-700 mt-1">⚠ Esse aluno não tem CPF — necessário para gerar cobrança no Asaas.</p>
            )}
          </div>

          <div>
            <Label>Coach *</Label>
            <Select value={form.coach_id} onValueChange={v => setForm(f => ({ ...f, coach_id: v }))}>
              <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione o coach" /></SelectTrigger>
              <SelectContent>
                {coaches.map(c => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} <span className="text-xs text-muted-foreground capitalize">({c.role})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Calendar className="w-4 h-4 text-blue-600" /> Período &amp; Parcelas
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Data de início *</Label>
              <Input
                type="date"
                className="mt-1"
                value={form.start_date}
                onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))}
              />
            </div>
            <div>
              <Label>Vencimento (automático)</Label>
              <Input type="date" value={endDate} disabled className="mt-1 bg-gray-50 text-muted-foreground" />
            </div>
          </div>

          {selectedPlan?.max_installments > 1 && (
            <div>
              <Label>Parcelas (até {selectedPlan.max_installments}x)</Label>
              <Input
                type="number"
                min="1"
                max={selectedPlan.max_installments}
                className="mt-1"
                value={form.installments}
                onChange={e => setForm(f => ({ ...f, installments: e.target.value }))}
              />
            </div>
          )}

          <label className="flex items-start gap-3 p-3 rounded-xl border border-gray-200 hover:border-blue-300 hover:bg-blue-50/40 cursor-pointer transition-colors">
            <input
              type="checkbox"
              checked={!!form.auto_renewal}
              onChange={e => setForm(f => ({ ...f, auto_renewal: e.target.checked }))}
              className="mt-0.5 w-4 h-4 accent-blue-600 shrink-0"
            />
            <div>
              <p className="text-sm font-medium flex items-center gap-1.5"><RotateCcw className="w-3.5 h-3.5 text-green-600" /> Renovação automática</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                O contrato será renovado automaticamente ao vencer.
              </p>
            </div>
          </label>

          <div className={`p-3 rounded-xl border transition-colors ${
            Number(form.enrollment_fee) > 0
              ? 'border-amber-200 bg-amber-50/40'
              : 'border-gray-200 bg-gray-50/40'
          }`}>
            <div className="flex items-center justify-between mb-2">
              <Label className="flex items-center gap-1.5 mb-0">
                <BadgeDollarSign className="w-3.5 h-3.5 text-amber-600" />
                Taxa de matrícula
              </Label>
              <div className="flex items-center gap-2 text-xs">
                {selectedPlan && Number(form.enrollment_fee) !== Number(selectedPlan.enrollment_fee) && (
                  <button
                    type="button"
                    onClick={() => setForm(f => ({ ...f, enrollment_fee: Number(selectedPlan.enrollment_fee) || 0 }))}
                    className="text-blue-600 hover:underline"
                  >
                    Restaurar padrão ({formatCurrency(selectedPlan.enrollment_fee)})
                  </button>
                )}
                {Number(form.enrollment_fee) > 0 && (
                  <button
                    type="button"
                    onClick={() => setForm(f => ({ ...f, enrollment_fee: 0 }))}
                    className="text-red-500 hover:underline"
                  >
                    Zerar
                  </button>
                )}
              </div>
            </div>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={form.enrollment_fee}
              onChange={e => setForm(f => ({ ...f, enrollment_fee: e.target.value }))}
              placeholder="0,00"
            />
            <p className="text-xs text-muted-foreground mt-1.5">
              {Number(form.enrollment_fee) > 0
                ? `Será cobrado ${formatCurrency(Number(form.enrollment_fee))} de matrícula neste contrato.`
                : 'Sem taxa de matrícula neste contrato.'}
              {selectedPlan && Number(selectedPlan.enrollment_fee) > 0 && (
                <span className="ml-1 text-amber-700">Padrão do plano: {formatCurrency(selectedPlan.enrollment_fee)}</span>
              )}
            </p>
          </div>

          {/* Desconto manual */}
          <div className="rounded-xl border bg-blue-50/30 p-3">
            <p className="text-sm font-semibold mb-2 flex items-center gap-1.5">
              💸 Desconto manual (opcional)
            </p>
            <DiscountInput
              subtotal={Number(selectedPlan?.price_total || 0) + (Number(form.enrollment_fee) || 0)}
              currentDiscount={Number(form.manual_discount) || 0}
              currentReason={form.discount_reason}
              compact
              onSave={(v, r) => setForm(f => ({ ...f, manual_discount: v, discount_reason: r }))}
            />
          </div>

          <div>
            <Label>Observações (opcional)</Label>
            <Textarea
              rows={2}
              className="mt-1"
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Notas internas sobre esse contrato..."
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex gap-2 justify-end pb-4">
        <Button variant="outline" onClick={() => setStep('plan')}>Voltar</Button>
        <Button onClick={save} disabled={saving} size="lg">
          <Save className="w-4 h-4 mr-1.5" /> {saving ? 'Criando...' : 'Criar contrato'}
        </Button>
      </div>

      {/* ── Modal: Cadastrar novo aluno inline ─────────────────────────────── */}
      <Dialog open={newCustomerModal} onOpenChange={setNewCustomerModal}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="w-5 h-5 text-blue-600" /> Cadastrar novo aluno
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Nome completo *</Label>
              <Input className="mt-1" value={newCustomer.full_name}
                onChange={e => setNewCustomer(c => ({ ...c, full_name: e.target.value }))}
                placeholder="ex: João Silva" autoFocus />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>WhatsApp</Label>
                <Input className="mt-1" value={newCustomer.whatsapp}
                  onChange={e => setNewCustomer(c => ({ ...c, whatsapp: e.target.value }))}
                  placeholder="48999887766" />
              </div>
              <div>
                <Label>Email</Label>
                <Input className="mt-1" type="email" value={newCustomer.email}
                  onChange={e => setNewCustomer(c => ({ ...c, email: e.target.value }))}
                  placeholder="joao@email.com" />
              </div>
            </div>
            <div>
              <Label>CPF</Label>
              <Input className="mt-1" value={newCustomer.cpf}
                onChange={e => setNewCustomer(c => ({ ...c, cpf: e.target.value }))}
                placeholder="000.000.000-00" />
              <p className="text-[11px] text-muted-foreground mt-1">
                Necessário para gerar cobrança no Asaas. Pode ser preenchido depois.
              </p>
            </div>
            <div className="flex gap-2 pt-2">
              <Button variant="outline" className="flex-1" onClick={() => setNewCustomerModal(false)} disabled={creatingCustomer}>
                Cancelar
              </Button>
              <Button className="flex-1" onClick={saveNewCustomer} disabled={creatingCustomer}>
                <Check className="w-4 h-4 mr-1.5" />
                {creatingCustomer ? 'Salvando...' : 'Cadastrar e selecionar'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

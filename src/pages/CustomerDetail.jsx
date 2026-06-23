import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, User, Phone, Mail, ShoppingCart, Edit2, Save, X, AlertTriangle, GitMerge, FileText, ChevronRight, Plus, Trophy, ShoppingBag } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PreSaleCustomer, PreSaleOrder, AssessmentContract, AssessmentPlan, AssessmentModality, AssessmentCoach, StockOrder } from '@/api/entities';
import { supabase } from '@/api/db';
import { formatCurrency, formatDate } from '@/lib/utils';
import { isEffectiveOpenSale, isEffectiveSale } from '@/lib/sales';
import { buildContractLifecycleRows } from '@/lib/assessment-contract-lifecycle';
import { toast } from 'sonner';

const PAYMENT_BADGE = { paid: 'success', partially_paid: 'warning', awaiting_charge: 'secondary', charge_sent: 'info', cancelled: 'destructive', refunded: 'outline' };
const PAYMENT_LABEL = { awaiting_charge: 'Pedido recebido', charge_sent: 'Cobrança enviada', paid: 'Pago', partially_paid: 'Parcialmente pago', cancelled: 'Cancelado', refunded: 'Reembolsado' };
export default function CustomerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [customer, setCustomer]     = useState(null);
  const [orders, setOrders]         = useState([]);
  const [contracts, setContracts]   = useState([]);
  const [plans, setPlans]           = useState([]);
  const [modalities, setModalities] = useState([]);
  const [coaches, setCoaches]       = useState([]);
  const [editing, setEditing]       = useState(false);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [sellModal, setSellModal] = useState(false);

  // Estado do modal de mesclagem
  const [mergeModal, setMergeModal] = useState(null); // { duplicate, duplicateOrders }
  const [merging, setMerging] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, allPresaleOrders, stockOrders, ct, pl, mo, co] = await Promise.all([
        PreSaleCustomer.get(id),
        PreSaleOrder.list().catch(() => []),
        StockOrder.filter({ customer_id: id }, '-created_date').catch(() => []),
        AssessmentContract.filter({ customer_id: id }, '-created_at').catch(() => []),
        AssessmentPlan.list().catch(() => []),
        AssessmentModality.list().catch(() => []),
        AssessmentCoach.list().catch(() => []),
      ]);
      setCustomer(c);
      setForm({
        full_name:      c.full_name,
        whatsapp:       c.whatsapp,
        email:          c.email,
        trainer:        c.trainer,
        cpf:            c.cpf || '',
        internal_notes: c.internal_notes || '',
      });
      // Mescla pedidos da pré-venda + loja
      const presaleOrders = allPresaleOrders
        .filter(o => o.customer_id === id)
        .map(o => ({ ...o, _type: 'presale' }));
      const stockOrdersTagged = stockOrders.map(o => ({ ...o, _type: 'stock' }));
      setOrders([...presaleOrders, ...stockOrdersTagged]
        .sort((a, b) => (b.created_date || '').localeCompare(a.created_date || '')));
      setContracts(ct);
      setPlans(pl);
      setModalities(mo);
      setCoaches(co);
    } catch (e) {
      console.error('Erro ao carregar cliente:', e);
    }
  }, [id]);

  useEffect(() => {
    const timer = setTimeout(() => { load(); }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  // Verifica se o CPF já existe em outro cliente antes de salvar
  const checkCpfConflict = async (cpf) => {
    const cleanCpf = cpf.replace(/\D/g, '');
    if (cleanCpf.length < 11) return null;

    const { data } = await supabase
      .from('presale_customers')
      .select('*')
      .eq('cpf', cpf.trim())
      .neq('id', id) // exclui o cliente atual
      .maybeSingle();

    return data || null;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Verifica conflito de CPF
      if (form.cpf && form.cpf !== customer.cpf) {
        const conflict = await checkCpfConflict(form.cpf);
        if (conflict) {
          // Busca pedidos do cliente duplicado
          const allOrders = await PreSaleOrder.list();
          const duplicateOrders = allOrders.filter(o => o.customer_id === conflict.id);
          setSaving(false);
          setMergeModal({ duplicate: conflict, duplicateOrders });
          return;
        }
      }

      await PreSaleCustomer.update(id, form);
      toast.success('Cliente atualizado!');
      setEditing(false);
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  // Mescla o cliente duplicado neste: move pedidos + apaga o duplicado
  const handleMerge = async () => {
    if (!mergeModal) return;
    setMerging(true);
    try {
      const { duplicate, duplicateOrders } = mergeModal;

      // 1. Move todos os pedidos do duplicado para este cliente
      if (duplicateOrders.length > 0) {
        await Promise.all(
          duplicateOrders.map(o =>
            supabase.from('presale_orders').update({ customer_id: id }).eq('id', o.id)
          )
        );
      }

      // 2. Salva o CPF neste cliente (e outros dados se o duplicado tiver infos extras)
      const mergedData = {
        ...form,
        // Aproveita dados do duplicado se este não tiver
        email: form.email || duplicate.email || '',
        trainer: form.trainer || duplicate.trainer || '',
        internal_notes: [form.internal_notes, duplicate.internal_notes].filter(Boolean).join('\n\n[Mesclado de outro perfil]\n') || '',
      };
      await PreSaleCustomer.update(id, mergedData);

      // 3. Apaga o cliente duplicado
      await supabase.from('presale_customers').delete().eq('id', duplicate.id);

      toast.success(`Clientes mesclados! ${duplicateOrders.length > 0 ? `${duplicateOrders.length} pedido(s) movido(s).` : ''}`);
      setMergeModal(null);
      setEditing(false);
      load();
    } catch (e) {
      toast.error(e.message || 'Erro ao mesclar clientes');
    } finally {
      setMerging(false);
    }
  };

  // Salva o CPF mesmo havendo conflito (sem mesclar)
  const handleSaveAnyway = async () => {
    setMergeModal(null);
    setSaving(true);
    try {
      await PreSaleCustomer.update(id, form);
      toast.success('Cliente atualizado!');
      setEditing(false);
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const plansById = useMemo(() => Object.fromEntries(plans.map(p => [p.id, p])), [plans]);
  const lifecycleRows = useMemo(
    () => buildContractLifecycleRows(contracts, { plansById }),
    [contracts, plansById]
  );

  if (!customer) return <div className="p-8 text-center text-muted-foreground">Carregando...</div>;

  const activeOrders   = orders.filter(o => o.payment_status !== 'cancelled');
  const effectiveOrders = activeOrders.filter(isEffectiveSale);
  const totalValue     = effectiveOrders.reduce((acc, o) => acc + (o.total_value || 0), 0);
  const totalPaid      = effectiveOrders.filter(o => o.payment_status === 'paid').reduce((acc, o) => acc + (o.total_value || 0), 0);
  const totalPending   = effectiveOrders.filter(o => o.payment_status !== 'paid').reduce((acc, o) => acc + (o.total_value || 0), 0);

  const CONTRACT_STATUS = {
    active:    { label: 'Ativo',      cls: 'bg-green-100 text-green-700' },
    overdue:   { label: 'Atrasado',   cls: 'bg-red-100 text-red-700' },
    on_leave:  { label: 'Licença',    cls: 'bg-amber-100 text-amber-700' },
    finished:  { label: 'Concluído',  cls: 'bg-gray-100 text-gray-600' },
    cancelled: { label: 'Cancelado',  cls: 'bg-red-100 text-red-500' },
    voided:    { label: 'Descartado', cls: 'bg-amber-100 text-amber-700' },
  };

  const activeContracts = lifecycleRows.filter(c => c.lifecycle?.counts?.active);

  // LTV unificado: loja + assessoria
  // Conta apenas contratos PAGOS (LTV = valor que realmente entrou)
  // Contratos cancelados sem pagamento ou ainda em aberto não contam
  const assessTotal = lifecycleRows
    .filter(c =>
      c.payment_status === 'paid' &&
      !['pending_sale', 'voided_sale'].includes(c.lifecycle?.type)
    )
    .reduce((acc, c) => acc + (Number(c.value) || 0), 0);
  const ltv = totalPaid + assessTotal;

  const activeContractMonthly = activeContracts.reduce((acc, c) => acc + (Number(c.monthly) || 0), 0);

  // ── Pagamentos em aberto (contratos + pedidos não pagos) ────────────────────
  const todayStr = new Date().toISOString().slice(0, 10);
  const openContracts = lifecycleRows
    .filter(c =>
      c.lifecycle?.counts?.active &&
      !['paid', 'refunded', 'cancelled'].includes(c.payment_status)
    )
    .map(c => {
      const daysOverdue = c.due_date && c.due_date < todayStr
        ? Math.round((new Date(todayStr) - new Date(c.due_date)) / 86400000)
        : 0;
      return { ...c, _value: Number(c.value) || 0, _daysOverdue: daysOverdue };
    });

  const openOrders = orders
    .filter(isEffectiveOpenSale)
    .map(o => ({
      ...o,
      _value: Number(o.total_value) || 0,
      _daysOverdue: o.due_date && o.due_date < todayStr
        ? Math.round((new Date(todayStr) - new Date(o.due_date)) / 86400000) : 0,
    }));

  const totalOpen = openContracts.reduce((s, c) => s + c._value, 0)
                  + openOrders.reduce((s, o) => s + o._value, 0);

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}><ArrowLeft className="w-4 h-4" /></Button>
        <div className="flex-1">
          <h2 className="text-xl font-bold">{customer.full_name}</h2>
          <p className="text-sm text-muted-foreground">Cliente desde {formatDate(customer.created_date)}</p>
        </div>
        {!editing ? (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setEditing(true)}><Edit2 className="w-4 h-4" /> Editar</Button>
            <Button onClick={() => setSellModal(true)} className="bg-blue-600 hover:bg-blue-700">
              <Plus className="w-4 h-4" /> Venda
            </Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setEditing(false)}><X className="w-4 h-4" /></Button>
            <Button onClick={handleSave} disabled={saving}><Save className="w-4 h-4" /> {saving ? 'Salvando...' : 'Salvar'}</Button>
          </div>
        )}
      </div>

      {/* Resumo financeiro — LTV primeiro */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="col-span-2 lg:col-span-1 bg-gray-900 border-gray-800">
          <CardContent className="p-4 text-center">
            <p className="text-xs text-gray-400">LTV total</p>
            <p className="text-2xl font-bold text-white mt-1">{formatCurrency(ltv)}</p>
            {activeContractMonthly > 0 && (
              <p className="text-xs text-green-400 mt-0.5">{formatCurrency(activeContractMonthly)}/mês recorrente</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-xs text-muted-foreground">Loja (pedidos)</p>
            <p className="text-xl font-bold mt-1">{formatCurrency(totalValue)}</p>
            {totalPending > 0 && <p className="text-xs text-yellow-600 mt-0.5">{formatCurrency(totalPending)} pendente</p>}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-xs text-muted-foreground">Assessoria</p>
            <p className="text-xl font-bold text-blue-700 mt-1">{formatCurrency(assessTotal)}</p>
            {activeContracts.length > 0 && (
              <p className="text-xs text-blue-500 mt-0.5">{activeContracts.length} contrato{activeContracts.length !== 1 ? 's' : ''} ativo{activeContracts.length !== 1 ? 's' : ''}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-xs text-muted-foreground">Total pago (loja)</p>
            <p className="text-xl font-bold text-green-600 mt-1">{formatCurrency(totalPaid)}</p>
            {totalPaid > 0 && totalValue > 0 && (
              <p className="text-xs text-muted-foreground mt-0.5">{Math.round((totalPaid/totalValue)*100)}% pago</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Pagamentos em aberto */}
      {totalOpen > 0 && (
        <Card className="border-red-200 bg-red-50/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2 text-red-700">
              <AlertTriangle className="w-4 h-4" /> Pagamentos em aberto
              <span className="text-xs font-semibold bg-red-100 text-red-700 px-2 py-0.5 rounded-full">
                {formatCurrency(totalOpen)}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="space-y-2">
              {openContracts.map(c => {
                const plan = plans.find(p => p.id === c.plan_id);
                const mod  = plan && modalities.find(m => m.id === plan.modality_id);
                return (
                  <Link key={c.id} to={`/assessoria/contratos/${c.id}`}
                    className="flex items-center gap-3 p-2.5 rounded-lg bg-white border hover:border-red-300 transition-colors">
                    <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium shrink-0">🏃 Contrato</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-mono font-semibold text-blue-700">{c.contract_number}</p>
                      <p className="text-xs text-muted-foreground capitalize truncate">
                        {mod?.name} · {plan?.name?.trim() || '—'}
                        {c.due_date && c._daysOverdue > 0 && (
                          <span className="text-red-600 font-semibold"> · {c._daysOverdue}d em atraso</span>
                        )}
                        {c.due_date && c._daysOverdue === 0 && c.due_date === todayStr && (
                          <span className="text-orange-600 font-semibold"> · vence hoje</span>
                        )}
                      </p>
                    </div>
                    <span className="font-semibold text-red-700 shrink-0">{formatCurrency(c._value)}</span>
                  </Link>
                );
              })}
              {openOrders.map(o => (
                <Link key={`${o._type}-${o.id}`}
                  to={o._type === 'stock' ? `/estoque/pedidos/${o.id}` : `/pedidos/${o.id}`}
                  className="flex items-center gap-3 p-2.5 rounded-lg bg-white border hover:border-red-300 transition-colors">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
                    o._type === 'stock' ? 'bg-purple-100 text-purple-700' : 'bg-amber-100 text-amber-700'
                  }`}>
                    {o._type === 'stock' ? '🛍️ Loja' : '📦 Pré-venda'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-mono font-semibold text-blue-700">{o.order_number}</p>
                    <p className="text-xs text-muted-foreground">
                      {o.due_date && o._daysOverdue > 0 && (
                        <span className="text-red-600 font-semibold">{o._daysOverdue}d em atraso</span>
                      )}
                      {o.due_date && o._daysOverdue === 0 && o.due_date === todayStr && (
                        <span className="text-orange-600 font-semibold">vence hoje</span>
                      )}
                      {(!o.due_date || (o._daysOverdue === 0 && o.due_date !== todayStr)) && (
                        <span>{PAYMENT_LABEL[o.payment_status] || o.payment_status}</span>
                      )}
                    </p>
                  </div>
                  <span className="font-semibold text-red-700 shrink-0">{formatCurrency(o._value)}</span>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Contratos de assessoria */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="w-4 h-4 text-blue-600" />
              🏃 Assessoria
              {activeContracts.length > 0 && (
                <span className="text-xs font-semibold bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
                  {activeContracts.length} ativo{activeContracts.length !== 1 ? 's' : ''}
                </span>
              )}
            </CardTitle>
            <Link
              to={`/assessoria/contratos/novo?customer_id=${id}`}
              className="text-xs text-blue-600 hover:underline font-medium"
              onClick={e => e.stopPropagation()}
            >
              + Novo contrato
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          {contracts.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              Nenhum contrato de assessoria ainda.{' '}
              <Link to={`/assessoria/contratos/novo?customer_id=${id}`} className="text-blue-600 hover:underline">
                Criar primeiro contrato →
              </Link>
            </p>
          ) : (
            <div className="divide-y">
              {lifecycleRows.map(c => {
                const plan = c.plan || plans.find(p => p.id === c.plan_id);
                const mod  = plan && modalities.find(m => m.id === plan.modality_id);
                const coach = coaches.find(co => co.id === c.coach_id);
                const st   = CONTRACT_STATUS[c.status] || { label: c.status, cls: 'bg-gray-100 text-gray-600' };
                return (
                  <Link
                    key={c.id}
                    to={`/assessoria/contratos/${c.id}`}
                    className="flex items-center gap-3 py-2.5 hover:bg-gray-50 rounded px-2 -mx-2"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="font-mono text-xs font-semibold text-blue-700">{c.contract_number}</p>
                      <p className="text-sm truncate">
                        <span className="capitalize">{mod?.name || '—'}</span>
                        {plan && <> · <span className="capitalize">{plan.period}</span></>}
                        {coach && <> · {coach.name}</>}
                      </p>
                      <p className="text-xs text-muted-foreground">{formatDate(c.start_date)} → {formatDate(c.end_date)}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold">{formatCurrency(c.value || 0)}</p>
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
                    </div>
                    <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                  </Link>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dados pessoais */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><User className="w-4 h-4" /> Dados do Cliente</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {editing ? (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div><Label>Nome completo</Label><Input value={form.full_name} onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} className="mt-1" /></div>
                <div><Label>WhatsApp</Label><Input value={form.whatsapp || ''} onChange={e => setForm(f => ({ ...f, whatsapp: e.target.value }))} className="mt-1" /></div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div><Label>E-mail</Label><Input value={form.email || ''} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="mt-1" /></div>
                <div><Label>Treinador</Label><Input value={form.trainer || ''} onChange={e => setForm(f => ({ ...f, trainer: e.target.value }))} className="mt-1" /></div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>
                    CPF{' '}
                    <span className="text-xs text-muted-foreground font-normal">(necessário para cobrança Asaas)</span>
                  </Label>
                  <Input
                    value={form.cpf || ''}
                    onChange={e => setForm(f => ({ ...f, cpf: e.target.value }))}
                    className="mt-1"
                    placeholder="000.000.000-00"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Se esse CPF já existir em outro cliente, você será avisado para mesclar os perfis.
                  </p>
                </div>
              </div>
              <div><Label>Observações internas</Label><Textarea value={form.internal_notes} onChange={e => setForm(f => ({ ...f, internal_notes: e.target.value }))} className="mt-1" rows={3} /></div>
            </>
          ) : (
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="flex items-center gap-2"><Phone className="w-4 h-4 text-muted-foreground" /><span>{customer.whatsapp || '-'}</span></div>
              <div className="flex items-center gap-2"><Mail className="w-4 h-4 text-muted-foreground" /><span>{customer.email || '-'}</span></div>
              <div className="flex items-center gap-2"><User className="w-4 h-4 text-muted-foreground" /><span>Treinador: {customer.trainer || '-'}</span></div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs">CPF:</span>
                {customer.cpf ? (
                  <span className="font-mono text-sm">{customer.cpf}</span>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-red-500 font-semibold">
                    <AlertTriangle className="w-3.5 h-3.5" /> não cadastrado
                  </span>
                )}
              </div>
              {customer.internal_notes && (
                <div className="col-span-2 bg-yellow-50 border border-yellow-200 rounded p-3 text-sm">{customer.internal_notes}</div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Histórico de pedidos */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><ShoppingCart className="w-4 h-4" /> Pedidos ({orders.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {orders.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">Nenhum pedido ainda</p>
          ) : (
            <div className="space-y-2">
              {orders.map(o => (
                <Link key={`${o._type}-${o.id}`}
                  to={o._type === 'stock' ? `/estoque/pedidos/${o.id}` : `/pedidos/${o.id}`}
                  className="flex items-center justify-between p-3 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-200 transition-colors">
                  <div>
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-mono font-semibold text-blue-700">{o.order_number}</p>
                      {o._type === 'stock' && (
                        <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded font-medium">Loja</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{formatDate(o.created_date)}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant={PAYMENT_BADGE[o.payment_status] || 'secondary'}>{PAYMENT_LABEL[o.payment_status] || o.payment_status}</Badge>
                    <span className="text-sm font-semibold">{formatCurrency(o.total_value)}</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Modal de mesclagem */}
      {mergeModal && (
        <Dialog open onOpenChange={() => setMergeModal(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-amber-600">
                <AlertTriangle className="w-5 h-5" /> CPF já cadastrado
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-4">
              <p className="text-sm text-gray-700">
                O CPF <span className="font-mono font-bold">{form.cpf}</span> já está registrado para outro cliente:
              </p>

              <div className="bg-gray-50 border rounded-xl p-4 space-y-1">
                <p className="font-semibold text-gray-900">{mergeModal.duplicate.full_name}</p>
                <p className="text-sm text-muted-foreground">{mergeModal.duplicate.whatsapp}</p>
                <p className="text-sm text-muted-foreground">{mergeModal.duplicate.email}</p>
                <p className="text-sm font-semibold text-blue-700 mt-2">
                  {mergeModal.duplicateOrders.length > 0
                    ? `${mergeModal.duplicateOrders.length} pedido(s): ${mergeModal.duplicateOrders.map(o => o.order_number).join(', ')}`
                    : 'Nenhum pedido'}
                </p>
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-sm text-blue-800">
                <p className="font-semibold flex items-center gap-1"><GitMerge className="w-4 h-4" /> O que acontece ao mesclar:</p>
                <ul className="mt-1 space-y-0.5 text-xs list-disc list-inside">
                  <li>Os pedidos do outro perfil são movidos para <strong>{customer.full_name}</strong></li>
                  <li>O perfil duplicado é removido permanentemente</li>
                  <li>Observações internas são combinadas</li>
                </ul>
              </div>

              <div className="flex flex-col gap-2 pt-1">
                <Button
                  className="w-full gap-2 bg-blue-600 hover:bg-blue-700"
                  onClick={handleMerge}
                  disabled={merging}
                >
                  <GitMerge className="w-4 h-4" />
                  {merging ? 'Mesclando...' : `Mesclar — mover ${mergeModal.duplicateOrders.length} pedido(s) para cá`}
                </Button>
                <Button variant="outline" className="w-full" onClick={handleSaveAnyway} disabled={merging}>
                  Salvar CPF sem mesclar (mantém duplicado)
                </Button>
                <Button variant="ghost" className="w-full" onClick={() => setMergeModal(null)} disabled={merging}>
                  Cancelar
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* ── Modal de Venda ─────────────────────────────────────────────────── */}
      <Dialog open={sellModal} onOpenChange={setSellModal}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Nova venda para {customer.full_name}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground -mt-2">O que você quer vender?</p>

          <div className="space-y-3 mt-2">
            {/* Plano da Assessoria */}
            <button
              onClick={() => {
                setSellModal(false);
                navigate(`/assessoria/contratos/novo?customer_id=${id}`);
              }}
              className="w-full text-left p-4 rounded-xl border-2 border-blue-200 hover:border-blue-500 hover:bg-blue-50 transition-all flex items-center gap-3 group"
            >
              <div className="w-11 h-11 rounded-xl bg-blue-100 flex items-center justify-center shrink-0 group-hover:bg-blue-200">
                <Trophy className="w-5 h-5 text-blue-700" />
              </div>
              <div className="flex-1">
                <p className="font-semibold text-gray-900">Plano de Assessoria</p>
                <p className="text-xs text-muted-foreground">Corrida, triathlon, etc · contrato mensal/trimestral/anual</p>
              </div>
              <ChevronRight className="w-5 h-5 text-muted-foreground group-hover:text-blue-600 transition-colors" />
            </button>

            {/* Produto da Loja */}
            <button
              onClick={() => {
                setSellModal(false);
                navigate(`/estoque/pedidos/novo?customer_id=${id}`);
              }}
              className="w-full text-left p-4 rounded-xl border-2 border-emerald-200 hover:border-emerald-500 hover:bg-emerald-50 transition-all flex items-center gap-3 group"
            >
              <div className="w-11 h-11 rounded-xl bg-emerald-100 flex items-center justify-center shrink-0 group-hover:bg-emerald-200">
                <ShoppingBag className="w-5 h-5 text-emerald-700" />
              </div>
              <div className="flex-1">
                <p className="font-semibold text-gray-900">Produto da Loja</p>
                <p className="text-xs text-muted-foreground">Tênis, camisetas, suplementos · pedido único</p>
              </div>
              <ChevronRight className="w-5 h-5 text-muted-foreground group-hover:text-emerald-600 transition-colors" />
            </button>
          </div>

          <Button variant="ghost" className="w-full mt-2" onClick={() => setSellModal(false)}>
            Cancelar
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

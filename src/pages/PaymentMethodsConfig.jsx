import { useEffect, useMemo, useState } from 'react';
import {
  CreditCard, Plus, Pencil, Trash2, Save, X, AlertTriangle,
  Lock, ChevronDown, ChevronRight, FolderPlus,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PaymentMethodConfig } from '@/api/entities';
import { formatCurrency } from '@/lib/utils';
import { toast } from 'sonner';

const KIND_LABEL = {
  pix:      'PIX',
  boleto:   'Boleto',
  credit:   'Crédito',
  cash:     'Dinheiro',
  transfer: 'Transferência',
  other:    'Outro',
};

const KIND_COLOR = {
  pix:      'bg-green-100 text-green-700',
  boleto:   'bg-amber-100 text-amber-700',
  credit:   'bg-blue-100 text-blue-700',
  cash:     'bg-gray-100 text-gray-700',
  transfer: 'bg-purple-100 text-purple-700',
  other:    'bg-slate-100 text-slate-600',
};

const emptyForm = {
  group_name:           'Sem gateway',
  name:                 '',
  kind:                 'pix',
  fee_percent:          0,
  fee_fixed:            0,
  credit_days_first:    1,
  credit_days_between:  30,
  installments:         1,
  active:               true,
};

export default function PaymentMethodsConfig() {
  const [methods, setMethods]       = useState([]);
  const [loading, setLoading]       = useState(true);
  const [collapsed, setCollapsed]   = useState({}); // grupo → bool
  const [editing, setEditing]       = useState(null); // método em edição ou 'new'
  const [form, setForm]             = useState(emptyForm);
  const [saving, setSaving]         = useState(false);

  const [groupModal, setGroupModal] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const data = await PaymentMethodConfig.list('order_index').catch(() => []);
      setMethods(data || []);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const grouped = useMemo(() => {
    const map = {};
    for (const m of methods) {
      if (!map[m.group_name]) map[m.group_name] = [];
      map[m.group_name].push(m);
    }
    // Asaas e Sem gateway primeiro, depois alfabético
    return Object.entries(map).sort(([a], [b]) => {
      if (a === 'Asaas') return -1;
      if (b === 'Asaas') return 1;
      if (a === 'Sem gateway') return -1;
      if (b === 'Sem gateway') return 1;
      return a.localeCompare(b);
    });
  }, [methods]);

  const openNew = (groupName = 'Sem gateway') => {
    setForm({ ...emptyForm, group_name: groupName });
    setEditing('new');
  };

  const openEdit = (method) => {
    setForm({ ...method });
    setEditing(method.id);
  };

  const save = async () => {
    if (!form.name?.trim()) return toast.error('Nome obrigatório');
    if (!form.group_name?.trim()) return toast.error('Grupo obrigatório');
    const payload = {
      group_name:          form.group_name.trim(),
      name:                form.name.trim(),
      kind:                form.kind,
      fee_percent:         Number(form.fee_percent) || 0,
      fee_fixed:           Number(form.fee_fixed) || 0,
      credit_days_first:   Math.max(0, Number(form.credit_days_first) || 0),
      credit_days_between: Math.max(0, Number(form.credit_days_between) || 30),
      installments:        Math.max(1, Math.min(12, Number(form.installments) || 1)),
      active:              !!form.active,
      internal_code:       form.internal_code || null,
    };
    setSaving(true);
    try {
      if (editing === 'new') {
        await PaymentMethodConfig.create(payload);
        toast.success('Método criado!');
      } else {
        await PaymentMethodConfig.update(editing, payload);
        toast.success('Método atualizado!');
      }
      setEditing(null);
      load();
    } catch (e) {
      toast.error(e.message || 'Erro ao salvar');
    } finally { setSaving(false); }
  };

  const remove = async (method) => {
    if (method.system) return toast.error('Métodos do sistema não podem ser deletados. Desative em vez disso.');
    if (!confirm(`Excluir "${method.name}"?`)) return;
    try {
      await PaymentMethodConfig.delete(method.id);
      toast.success('Método excluído');
      load();
    } catch (e) { toast.error(e.message); }
  };

  const toggleActive = async (method) => {
    try {
      await PaymentMethodConfig.update(method.id, { active: !method.active });
      load();
    } catch (e) { toast.error(e.message); }
  };

  if (loading) return <div className="p-8 text-center text-muted-foreground">Carregando...</div>;

  return (
    <div className="space-y-5 max-w-4xl mx-auto">
      {/* Cabeçalho */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-blue-600" /> Métodos de Pagamento
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Configure taxas, prazos e parcelamento. Usado no registro manual de pagamentos para projetar parcelas no fluxo de caixa.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => { setNewGroupName(''); setGroupModal(true); }}>
            <FolderPlus className="w-3.5 h-3.5 mr-1.5" /> Novo grupo
          </Button>
          <Button size="sm" onClick={() => openNew()}>
            <Plus className="w-3.5 h-3.5 mr-1.5" /> Novo método
          </Button>
        </div>
      </div>

      {/* Banner explicativo */}
      <Card className="border-blue-200 bg-blue-50/50">
        <CardContent className="p-4 flex gap-3">
          <AlertTriangle className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold text-blue-900">Como o sistema usa esses métodos</p>
            <p className="text-xs text-blue-700 mt-0.5">
              Quando você registrar um pagamento manual (ex: "cartão cliente em 4x"), o sistema vai usar a <b>taxa</b> e os <b>prazos</b> aqui para projetar quando cada parcela vai cair na conta. As parcelas aparecem confirmadas no Fluxo de Caixa.
              <br />
              <span className="text-blue-900 font-medium">Métodos do sistema</span> (Asaas, Sem gateway) podem ser editados mas não deletados — desative se preferir não usar.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Lista agrupada */}
      {grouped.map(([groupName, list]) => {
        const isCollapsed = collapsed[groupName];
        const activeCount = list.filter(m => m.active).length;
        return (
          <Card key={groupName}>
            <button
              onClick={() => setCollapsed(c => ({ ...c, [groupName]: !c[groupName] }))}
              className="w-full text-left hover:bg-gray-50 transition-colors"
            >
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    {groupName}
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                      {activeCount} ativo{activeCount !== 1 ? 's' : ''} de {list.length}
                    </span>
                  </CardTitle>
                  <Button variant="ghost" size="sm"
                    onClick={e => { e.stopPropagation(); openNew(groupName); }}
                    className="text-xs">
                    <Plus className="w-3.5 h-3.5 mr-1" /> Adicionar
                  </Button>
                </div>
              </CardHeader>
            </button>
            {!isCollapsed && (
              <CardContent className="pt-0">
                <div className="divide-y border-t">
                  {list.map(m => {
                    const kColor = KIND_COLOR[m.kind] || 'bg-gray-100 text-gray-600';
                    return (
                      <div key={m.id} className={`flex items-center gap-3 py-2.5 ${!m.active ? 'opacity-50' : ''}`}>
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${kColor}`}>
                          {KIND_LABEL[m.kind] || m.kind}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium">{m.name}</span>
                            {m.system && (
                              <span className="text-[10px] text-muted-foreground inline-flex items-center gap-0.5">
                                <Lock className="w-2.5 h-2.5" /> sistema
                              </span>
                            )}
                            {m.installments > 1 && (
                              <span className="text-[10px] bg-amber-100 text-amber-700 px-1 py-0.5 rounded">{m.installments}x</span>
                            )}
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            Taxa: <b>{Number(m.fee_percent || 0).toFixed(2)}%</b>
                            {m.fee_fixed > 0 && <> + R$ {Number(m.fee_fixed).toFixed(2)} fixo</>}
                            {' · '}
                            1ª parcela em D+{m.credit_days_first}
                            {m.installments > 1 && <>, próximas a cada {m.credit_days_between}d</>}
                          </p>
                        </div>
                        <button
                          onClick={() => toggleActive(m)}
                          className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${m.active ? 'bg-green-100 text-green-700 hover:bg-green-200' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
                          {m.active ? 'Ativo' : 'Inativo'}
                        </button>
                        <Button variant="ghost" size="icon" onClick={() => openEdit(m)} className="h-7 w-7">
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        {!m.system && (
                          <Button variant="ghost" size="icon" onClick={() => remove(m)} className="h-7 w-7 text-red-500 hover:text-red-700 hover:bg-red-50">
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
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

      {/* Modal: editar / novo */}
      <Dialog open={!!editing} onOpenChange={open => !open && !saving && setEditing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {editing === 'new' ? <Plus className="w-4 h-4 text-blue-600" /> : <Pencil className="w-4 h-4 text-blue-600" />}
              {editing === 'new' ? 'Novo método' : 'Editar método'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Grupo *</Label>
                <Input className="mt-1" value={form.group_name}
                  onChange={e => setForm(f => ({ ...f, group_name: e.target.value }))}
                  placeholder="Asaas, Stone, etc." />
              </div>
              <div>
                <Label>Tipo *</Label>
                <Select value={form.kind} onValueChange={v => setForm(f => ({ ...f, kind: v }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(KIND_LABEL).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Nome *</Label>
              <Input className="mt-1" value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Ex: Cartão crédito 4x" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Taxa (%)</Label>
                <Input type="number" step="0.01" min="0" className="mt-1"
                  value={form.fee_percent}
                  onChange={e => setForm(f => ({ ...f, fee_percent: e.target.value }))} />
              </div>
              <div>
                <Label>Taxa fixa (R$)</Label>
                <Input type="number" step="0.01" min="0" className="mt-1"
                  value={form.fee_fixed}
                  onChange={e => setForm(f => ({ ...f, fee_fixed: e.target.value }))} />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Parcelas</Label>
                <Input type="number" min="1" max="12" className="mt-1"
                  value={form.installments}
                  onChange={e => setForm(f => ({ ...f, installments: e.target.value }))} />
              </div>
              <div>
                <Label>D+ 1ª</Label>
                <Input type="number" min="0" className="mt-1"
                  value={form.credit_days_first}
                  onChange={e => setForm(f => ({ ...f, credit_days_first: e.target.value }))} />
              </div>
              <div>
                <Label>D+ entre</Label>
                <Input type="number" min="0" className="mt-1"
                  value={form.credit_days_between}
                  onChange={e => setForm(f => ({ ...f, credit_days_between: e.target.value }))} />
              </div>
            </div>

            <p className="text-xs text-muted-foreground bg-gray-50 border rounded-lg px-3 py-2">
              {(() => {
                const v = 1000;
                const fee = (v * (Number(form.fee_percent) / 100)) + Number(form.fee_fixed || 0);
                const liq = v - fee;
                return <>Exemplo em R$ 1.000,00: taxa = <b>{formatCurrency(fee)}</b> · líquido = <b>{formatCurrency(liq)}</b>{Number(form.installments) > 1 && <> · {form.installments}x de {formatCurrency(liq / Number(form.installments))}</>}</>;
              })()}
            </p>

            <label className="flex items-center gap-2 cursor-pointer text-sm">
              <input type="checkbox" checked={!!form.active}
                onChange={e => setForm(f => ({ ...f, active: e.target.checked }))}
                className="w-4 h-4 accent-blue-600" />
              Método ativo (aparece nos dropdowns)
            </label>

            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setEditing(null)} disabled={saving}>
                <X className="w-3.5 h-3.5 mr-1.5" /> Cancelar
              </Button>
              <Button className="flex-1" onClick={save} disabled={saving}>
                <Save className="w-3.5 h-3.5 mr-1.5" /> {saving ? 'Salvando...' : 'Salvar'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Modal: novo grupo */}
      <Dialog open={groupModal} onOpenChange={setGroupModal}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><FolderPlus className="w-4 h-4 text-blue-600" /> Novo grupo</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Crie um grupo (ex: "Stone", "Cielo") e depois adicione métodos dentro dele.</p>
            <div>
              <Label>Nome do grupo</Label>
              <Input className="mt-1" value={newGroupName}
                onChange={e => setNewGroupName(e.target.value)}
                placeholder="Ex: Stone, Cielo, PagSeguro..." />
            </div>
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setGroupModal(false)}>Cancelar</Button>
              <Button className="flex-1" onClick={() => {
                if (!newGroupName.trim()) return toast.error('Informe o nome');
                setGroupModal(false);
                openNew(newGroupName.trim());
              }}>
                Criar e adicionar método
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

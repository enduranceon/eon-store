import { useState } from 'react';
import { Plus, Pencil, Trash2, Save, Calendar, MessageCircle, DollarSign, Info } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { RenewalRule } from '@/api/entities';
import { usePageData } from '@/hooks/usePageData';
import { toast } from 'sonner';

const ACTION_TYPES = [
  { value: 'whatsapp',                      label: 'Apenas WhatsApp',                    icon: MessageCircle, color: 'text-blue-600',  description: 'Só abre o WhatsApp com a mensagem pronta — sem gerar cobrança' },
  { value: 'generate_charge_and_whatsapp',  label: 'Gerar cobrança + WhatsApp com link', icon: DollarSign,    color: 'text-green-600', description: 'Gera PIX/Boleto no Asaas E já abre WhatsApp com o link pronto' },
];

const VARIABLES = [
  { key: '{nome}',            description: 'Primeiro nome do aluno' },
  { key: '{nome_completo}',   description: 'Nome completo do aluno' },
  { key: '{plano}',           description: 'Nome do plano (ex: "Corrida · 3 meses")' },
  { key: '{vencimento}',      description: 'Data de vencimento — do contrato (renovação) ou da cobrança (pagamento)' },
  { key: '{dias_restantes}',  description: 'Texto tipo "10 dias" ou "1 dia"' },
  { key: '{valor}',           description: 'Valor — total do contrato ou da cobrança' },
  { key: '{mensalidade}',     description: 'Mensalidade do plano (ex: R$ 220,00)' },
  { key: '{link_pagamento}',  description: 'Link Asaas (se já gerado) ou texto vazio' },
];

const COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#06b6d4', '#f59e0b', '#ef4444', '#ec4899', '#6b7280'];

const TYPE_INFO = {
  renewal: {
    label:    'Renovação',
    emoji:    '🔁',
    desc:     'Sobre o vencimento do CONTRATO. Dispara em torno do end_date.',
    fieldRef: 'end_date',
  },
  payment: {
    label:    'Pagamento',
    emoji:    '💳',
    desc:     'Sobre o vencimento da COBRANÇA/parcela. Dispara em torno do due_date.',
    fieldRef: 'due_date',
  },
};

async function loadRenewalRulesPage() {
  return RenewalRule.list('order_index').catch(() => []);
}

export default function Regua() {
  const { data: rules, loading, refresh } = usePageData({
    key: 'renewal-rules:list',
    loader: loadRenewalRulesPage,
    initialData: [],
    tags: ['renewal_rules'],
    onError: error => console.error(error),
  });
  const [modal, setModal]     = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm]       = useState({});
  const [activeTab, setActiveTab] = useState('renewal'); // 'renewal' | 'payment'

  const open = (r) => {
    setEditing(r);
    setForm(r || {
      name: '', days_offset: activeTab === 'renewal' ? -10 : -3,
      action_type: 'whatsapp',
      rule_type: activeTab,
      message_template: '', icon: activeTab === 'renewal' ? '📨' : '⏰',
      color: '#3b82f6',
      order_index: rules.length + 1, active: true,
    });
    setModal(true);
  };

  const save = async () => {
    if (!form.name?.trim()) return toast.error('Nome obrigatório');
    if (!form.message_template?.trim()) return toast.error('Mensagem obrigatória');
    const payload = {
      name:             form.name.trim(),
      rule_type:        form.rule_type || activeTab,
      days_offset:      Number(form.days_offset) || 0,
      action_type:      form.action_type || 'whatsapp',
      message_template: form.message_template.trim(),
      icon:             form.icon || '📨',
      color:            form.color || '#3b82f6',
      order_index:      Number(form.order_index) || 0,
      active:           !!form.active,
    };
    try {
      if (editing?.id) await RenewalRule.update(editing.id, payload);
      else             await RenewalRule.create(payload);
      toast.success('Regra salva!');
      setModal(false);
      await refresh({ force: true });
    } catch (e) { toast.error(e.message); }
  };

  const remove = async (r) => {
    if (!confirm(`Excluir a regra "${r.name}"?\n\nAções já registradas no histórico permanecem (não são apagadas).`)) return;
    try {
      await RenewalRule.delete(r.id);
      toast.success('Regra excluída');
      await refresh({ force: true });
    }
    catch (e) { toast.error(e.message); }
  };

  const toggle = async (r) => {
    try {
      await RenewalRule.update(r.id, { active: !r.active });
      await refresh({ force: true });
    }
    catch (e) { toast.error(e.message); }
  };

  const f = (key, val) => setForm(prev => ({ ...prev, [key]: val }));

  if (loading) return <div className="p-8 text-center text-muted-foreground">Carregando...</div>;

  // Filtra por tipo e ordena
  const tabRules = rules.filter(r => (r.rule_type || 'renewal') === activeTab);
  const sortedRules = [...tabRules].sort((a, b) => a.days_offset - b.days_offset);

  const tabInfo = TYPE_INFO[activeTab];

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Régua de Comunicação</h2>
          <p className="text-sm text-muted-foreground">
            Defina o que fazer e quando, na renovação do contrato e na cobrança das parcelas.
          </p>
        </div>
        <Button onClick={() => open(null)}>
          <Plus className="w-4 h-4 mr-1.5" /> Nova regra
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {Object.entries(TYPE_INFO).map(([key, info]) => {
          const count = rules.filter(r => (r.rule_type || 'renewal') === key).length;
          return (
            <button key={key}
              onClick={() => setActiveTab(key)}
              className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors flex items-center gap-2 ${
                activeTab === key
                  ? 'border-blue-600 text-blue-700'
                  : 'border-transparent text-muted-foreground hover:text-gray-700'
              }`}>
              <span>{info.emoji}</span>
              <span>Régua de {info.label}</span>
              <span className="text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-full">{count}</span>
            </button>
          );
        })}
      </div>

      {/* Descrição da aba */}
      <div className="rounded-lg bg-blue-50/50 border border-blue-100 px-3 py-2 text-xs text-blue-800">
        <strong>{tabInfo.emoji} Régua de {tabInfo.label}:</strong> {tabInfo.desc}
      </div>

      {/* Timeline visual */}
      <Card className="bg-gradient-to-br from-blue-50 to-purple-50 border-blue-100">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Calendar className="w-4 h-4 text-blue-600" />
            <p className="text-sm font-semibold text-gray-900">Linha do tempo</p>
          </div>
          <div className="flex items-center gap-1 overflow-x-auto pb-2">
            {sortedRules.filter(r => r.active).map((r, idx) => {
              const label = r.days_offset < 0 ? `${Math.abs(r.days_offset)}d antes`
                          : r.days_offset === 0 ? 'No dia'
                          : `${r.days_offset}d depois`;
              return (
                <div key={r.id} className="flex items-center gap-1 shrink-0">
                  {idx > 0 && <div className="h-px w-4 bg-gray-300" />}
                  <div className="rounded-lg border-2 bg-white px-2 py-1 text-center shrink-0"
                    style={{ borderColor: r.color }}>
                    <div className="text-lg leading-none">{r.icon}</div>
                    <div className="text-[10px] font-bold mt-0.5">{label}</div>
                  </div>
                </div>
              );
            })}
            {sortedRules.filter(r => r.active).length > 0 && (
              <div className="flex items-center gap-1 shrink-0">
                <div className="h-px w-4 bg-gray-300" />
                <div className="text-xs text-gray-500 px-2">📅 Venc.</div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Lista de regras */}
      <div className="space-y-3">
        {sortedRules.map(r => {
          const actionInfo = ACTION_TYPES.find(a => a.value === r.action_type);
          const ActionIcon = actionInfo?.icon || MessageCircle;
          const label = r.days_offset < 0 ? `${Math.abs(r.days_offset)} dia${Math.abs(r.days_offset) !== 1 ? 's' : ''} ANTES do vencimento`
                      : r.days_offset === 0 ? 'NO DIA do vencimento'
                      : `${r.days_offset} dia${r.days_offset !== 1 ? 's' : ''} DEPOIS do vencimento`;

          return (
            <div key={r.id}
              className={`rounded-xl border-2 bg-white p-4 transition-all ${
                r.active ? 'border-gray-200 hover:shadow-sm' : 'opacity-50 border-gray-100'
              }`}
              style={{ borderLeftColor: r.color, borderLeftWidth: 6 }}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  <div className="text-2xl">{r.icon}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-gray-900">{r.name}</p>
                      <span className="text-[10px] font-bold bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{label}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-semibold flex items-center gap-1 ${actionInfo?.color || 'text-gray-600'}`}>
                        <ActionIcon className="w-3 h-3" />
                        {actionInfo?.label || r.action_type}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1.5 whitespace-pre-wrap line-clamp-3">{r.message_template}</p>
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button onClick={() => toggle(r)}
                    className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                      r.active ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-500'
                    }`}>
                    {r.active ? 'Ativa' : 'Inativa'}
                  </button>
                  <button onClick={() => open(r)} className="p-1 hover:bg-gray-100 rounded text-gray-500" title="Editar">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => remove(r)} className="p-1 hover:bg-red-50 rounded text-gray-400 hover:text-red-600" title="Excluir">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {sortedRules.length === 0 && (
        <Card>
          <CardContent className="py-16 text-center">
            <Calendar className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground text-sm">Nenhuma regra cadastrada.</p>
            <Button className="mt-4" onClick={() => open(null)}>
              <Plus className="w-4 h-4 mr-1.5" /> Criar primeira regra
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Modal de edição */}
      <Dialog open={modal} onOpenChange={setModal}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing?.id ? 'Editar regra' : 'Nova regra'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">

            {/* Nome */}
            <div>
              <Label>Nome da regra *</Label>
              <Input className="mt-1" value={form.name || ''}
                onChange={e => f('name', e.target.value)}
                placeholder="ex: Pré-renovação" />
            </div>

            {/* Quando disparar */}
            <div>
              <Label>Quando disparar (dias relativos ao vencimento)</Label>
              <div className="flex items-center gap-3 mt-1">
                <Input type="number" className="w-24" value={form.days_offset ?? 0}
                  onChange={e => f('days_offset', e.target.value)} />
                <span className="text-sm text-muted-foreground">
                  {Number(form.days_offset) < 0
                    ? <><strong>{Math.abs(Number(form.days_offset))} dia{Math.abs(Number(form.days_offset)) !== 1 ? 's' : ''}</strong> antes do vencimento</>
                    : Number(form.days_offset) === 0
                    ? <strong>No dia do vencimento</strong>
                    : <><strong>{Number(form.days_offset)} dia{Number(form.days_offset) !== 1 ? 's' : ''}</strong> depois do vencimento</>}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Use valor negativo para ANTES (ex: -10 = 10 dias antes) ou positivo para DEPOIS.
              </p>
            </div>

            {/* Tipo de ação */}
            <div>
              <Label>Tipo de ação</Label>
              <div className="space-y-2 mt-2">
                {ACTION_TYPES.map(a => {
                  const Ai = a.icon;
                  return (
                    <button key={a.value} type="button"
                      onClick={() => f('action_type', a.value)}
                      className={`w-full text-left p-3 rounded-lg border-2 transition-all flex items-center gap-3 ${
                        form.action_type === a.value
                          ? 'border-blue-500 bg-blue-50'
                          : 'border-gray-200 hover:border-blue-300'
                      }`}>
                      <Ai className={`w-5 h-5 ${a.color}`} />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm">{a.label}</p>
                        <p className="text-xs text-muted-foreground">{a.description}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Mensagem */}
            <div>
              <Label>Template da mensagem (WhatsApp)</Label>
              <Textarea rows={6} className="mt-1 font-mono text-sm"
                value={form.message_template || ''}
                onChange={e => f('message_template', e.target.value)}
                placeholder="Oi, {nome}! Seu plano {plano} vence em {dias_restantes}..." />

              <div className="mt-2 rounded-lg border border-blue-100 bg-blue-50/30 p-3">
                <p className="text-xs font-semibold text-blue-900 mb-2 flex items-center gap-1">
                  <Info className="w-3 h-3" /> Variáveis disponíveis (clica pra copiar)
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {VARIABLES.map(v => (
                    <button key={v.key} type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(v.key);
                        toast.success(`${v.key} copiado!`);
                      }}
                      title={v.description}
                      className="text-[11px] font-mono bg-white border border-blue-200 hover:border-blue-400 hover:bg-blue-50 px-2 py-0.5 rounded">
                      {v.key}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Ícone + Cor */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Emoji</Label>
                <Input className="mt-1" maxLength={4} value={form.icon || '📨'}
                  onChange={e => f('icon', e.target.value)} />
              </div>
              <div>
                <Label>Cor</Label>
                <div className="flex gap-1.5 mt-2">
                  {COLORS.map(c => (
                    <button key={c} type="button"
                      onClick={() => f('color', c)}
                      className={`w-6 h-6 rounded-full transition-transform ${
                        form.color === c ? 'ring-2 ring-offset-1 ring-gray-600 scale-110' : 'hover:scale-110'
                      }`}
                      style={{ backgroundColor: c }} />
                  ))}
                </div>
              </div>
            </div>

            {/* Ativo */}
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={!!form.active}
                onChange={e => f('active', e.target.checked)}
                className="w-4 h-4 accent-blue-600" />
              <span className="text-sm">Regra ativa</span>
            </label>

            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setModal(false)}>Cancelar</Button>
              <Button className="flex-1" onClick={save}>
                <Save className="w-4 h-4 mr-1.5" /> Salvar
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

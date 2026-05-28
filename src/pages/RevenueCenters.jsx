import { useEffect, useState } from 'react';
import { Plus, Pencil, Palette, Check, Trash2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { RevenueCenter } from '@/api/entities';
import { toast } from 'sonner';

const TYPE_LABEL = {
  assessoria: '🏃 Assessoria',
  loja:       '🛍️ Loja',
  eventos:    '🎪 Eventos',
  general:    '📁 Geral',
};

const COLORS = [
  '#3b82f6', // azul
  '#8b5cf6', // roxo
  '#10b981', // verde
  '#06b6d4', // ciano
  '#f59e0b', // âmbar
  '#ef4444', // vermelho
  '#ec4899', // rosa
  '#6b7280', // cinza
];

export default function RevenueCenters() {
  const [centers, setCenters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal]     = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm]       = useState({});

  const load = async () => {
    setLoading(true);
    try {
      const data = await RevenueCenter.list('name').catch(() => []);
      setCenters(data);
    } catch (e) {
      console.error('Erro:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const open = (c) => {
    setEditing(c);
    setForm(c || { name: '', type: 'general', color: '#3b82f6', description: '', active: true });
    setModal(true);
  };

  const save = async () => {
    if (!form.name?.trim()) return toast.error('Nome obrigatório');
    const payload = {
      name:        form.name.trim(),
      type:        form.type || 'general',
      color:       form.color || '#3b82f6',
      description: form.description?.trim() || null,
      active:      !!form.active,
    };
    try {
      if (editing) await RevenueCenter.update(editing.id, payload);
      else         await RevenueCenter.create(payload);
      toast.success('Centro salvo!');
      setModal(false);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const toggle = async (c) => {
    try { await RevenueCenter.update(c.id, { active: !c.active }); load(); }
    catch (e) { toast.error(e.message); }
  };

  const remove = async () => {
    if (!editing?.id) return;
    if (!confirm(`Excluir "${editing.name}"?\n\nPlanos e produtos vinculados ficarão sem centro de receita (não serão deletados).`)) return;
    try {
      await RevenueCenter.delete(editing.id);
      toast.success('Centro removido');
      setModal(false);
      load();
    } catch (e) { toast.error(e.message); }
  };

  // Agrupar por tipo
  const grouped = ['assessoria', 'loja', 'eventos', 'general'].map(type => ({
    type,
    centers: centers.filter(c => (c.type || 'general') === type),
  })).filter(g => g.centers.length > 0);

  if (loading) return <div className="p-8 text-center text-muted-foreground">Carregando...</div>;

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Centros de Receita</h2>
          <p className="text-sm text-muted-foreground">
            Organize seu faturamento por categoria — assessoria, loja, eventos, etc.
          </p>
        </div>
        <Button onClick={() => open(null)}>
          <Plus className="w-4 h-4 mr-1.5" /> Novo centro
        </Button>
      </div>

      {centers.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Palette className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground text-sm">Nenhum centro de receita cadastrado.</p>
            <Button className="mt-4" onClick={() => open(null)}>
              <Plus className="w-4 h-4 mr-1.5" /> Criar primeiro
            </Button>
          </CardContent>
        </Card>
      ) : (
        grouped.map(({ type, centers: tCenters }) => (
          <div key={type}>
            <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground mb-3">
              {TYPE_LABEL[type]}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {tCenters.map(c => (
                <div key={c.id}
                  className={`relative rounded-xl border-2 bg-white p-4 transition-all hover:shadow-md ${
                    c.active ? 'border-gray-200' : 'opacity-50 border-gray-100'
                  }`}
                  style={{ borderLeftColor: c.color, borderLeftWidth: 6 }}
                >
                  <button onClick={() => toggle(c)}
                    className={`absolute top-3 right-3 text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                      c.active ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-500'
                    }`}>
                    {c.active ? 'Ativo' : 'Inativo'}
                  </button>

                  <div className="pr-14">
                    <p className="font-semibold text-gray-900">{c.name}</p>
                    {c.description && <p className="text-xs text-muted-foreground mt-1">{c.description}</p>}
                  </div>

                  <div className="mt-3 flex items-center gap-3">
                    <button onClick={() => open(c)}
                      className="text-xs text-gray-500 hover:text-blue-600 inline-flex items-center gap-1">
                      <Pencil className="w-3 h-3" /> Editar
                    </button>
                    <button
                      onClick={async () => {
                        if (!confirm(`Excluir "${c.name}"?\n\nPlanos e produtos vinculados ficarão sem centro (não serão deletados).`)) return;
                        try { await RevenueCenter.delete(c.id); toast.success('Removido'); load(); }
                        catch (e) { toast.error(e.message); }
                      }}
                      className="text-xs text-gray-400 hover:text-red-600 inline-flex items-center gap-1">
                      <Trash2 className="w-3 h-3" /> Excluir
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      {/* Modal */}
      <Dialog open={modal} onOpenChange={setModal}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? 'Editar centro' : 'Novo centro de receita'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Nome *</Label>
              <Input value={form.name || ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="ex: Loja · Lifestyle" className="mt-1" autoFocus />
            </div>

            <div>
              <Label>Tipo</Label>
              <div className="flex flex-wrap gap-2 mt-2">
                {Object.entries(TYPE_LABEL).map(([key, label]) => (
                  <button key={key} type="button"
                    onClick={() => setForm(f => ({ ...f, type: key }))}
                    className={`px-3 py-1.5 rounded-lg border-2 text-sm font-medium transition-all ${
                      form.type === key
                        ? 'border-blue-500 bg-blue-50 text-blue-700'
                        : 'border-gray-200 text-gray-600 hover:border-blue-300'
                    }`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <Label>Cor (para identificar nos relatórios)</Label>
              <div className="flex gap-2 mt-2">
                {COLORS.map(c => (
                  <button key={c} type="button"
                    onClick={() => setForm(f => ({ ...f, color: c }))}
                    className={`w-8 h-8 rounded-full transition-transform ${
                      form.color === c ? 'ring-2 ring-offset-2 ring-blue-500 scale-110' : 'hover:scale-110'
                    }`}
                    style={{ backgroundColor: c }}>
                    {form.color === c && <Check className="w-4 h-4 text-white mx-auto" />}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <Label>Descrição (opcional)</Label>
              <Input value={form.description || ''} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="ex: produtos de lifestyle e camisetas" className="mt-1" />
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={!!form.active}
                onChange={e => setForm(f => ({ ...f, active: e.target.checked }))}
                className="w-4 h-4 accent-blue-600" />
              <span className="text-sm">Centro ativo</span>
            </label>

            <div className="flex flex-col gap-2 pt-1">
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setModal(false)}>Cancelar</Button>
                <Button className="flex-1" onClick={save}>
                  <Check className="w-3.5 h-3.5 mr-1.5" /> Salvar
                </Button>
              </div>
              {editing?.id && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={remove}
                  className="text-red-600 hover:bg-red-50 hover:text-red-700 mt-1"
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Excluir este centro
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

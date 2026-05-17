import { useEffect, useState } from 'react';
import { Plus, UserCheck, Trash2, Edit2, Check, X, Phone, Mail } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PreSaleTrainer } from '@/api/entities';
import { toast } from 'sonner';

export default function Trainers() {
  const [trainers, setTrainers] = useState([]);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState(null); // { id, name, whatsapp, email }
  const [adding, setAdding] = useState(false);
  const [newForm, setNewForm] = useState({ name: '', whatsapp: '', email: '' });

  const load = () => PreSaleTrainer.list().then(setTrainers);
  useEffect(() => { load(); }, []);

  const handleAdd = async () => {
    if (!newForm.name.trim()) return;
    if (trainers.find(t => t.name.toLowerCase() === newForm.name.trim().toLowerCase()))
      return toast.error('Treinador já cadastrado');
    await PreSaleTrainer.create({ name: newForm.name.trim(), whatsapp: newForm.whatsapp, email: newForm.email });
    setNewForm({ name: '', whatsapp: '', email: '' });
    setAdding(false);
    toast.success('Treinador cadastrado!');
    load();
  };

  const handleSave = async () => {
    if (!editing.name.trim()) return;
    await PreSaleTrainer.update(editing.id, { name: editing.name.trim(), whatsapp: editing.whatsapp, email: editing.email });
    setEditing(null);
    load();
  };

  const handleDelete = async (t) => {
    if (!confirm(`Excluir "${t.name}"?`)) return;
    await PreSaleTrainer.delete(t.id);
    toast.success('Treinador excluído');
    load();
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Treinadores</h2>
          <p className="text-sm text-muted-foreground">{trainers.length} treinador{trainers.length !== 1 ? 'es' : ''} cadastrado{trainers.length !== 1 ? 's' : ''}</p>
        </div>
        <Button onClick={() => setAdding(a => !a)}>
          <Plus className="w-4 h-4" /> Novo Treinador
        </Button>
      </div>

      {/* Formulário de adição */}
      {adding && (
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 space-y-3">
          <p className="text-sm font-semibold text-blue-800">Novo treinador</p>
          <Input
            placeholder="Nome completo *"
            value={newForm.name}
            onChange={e => setNewForm(f => ({ ...f, name: e.target.value }))}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            autoFocus
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              placeholder="WhatsApp"
              value={newForm.whatsapp}
              onChange={e => setNewForm(f => ({ ...f, whatsapp: e.target.value }))}
            />
            <Input
              placeholder="E-mail"
              type="email"
              value={newForm.email}
              onChange={e => setNewForm(f => ({ ...f, email: e.target.value }))}
            />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" size="sm" onClick={() => { setAdding(false); setNewForm({ name: '', whatsapp: '', email: '' }); }}>
              Cancelar
            </Button>
            <Button size="sm" onClick={handleAdd} disabled={!newForm.name.trim()}>
              <Check className="w-3.5 h-3.5" /> Salvar
            </Button>
          </div>
        </div>
      )}

      {trainers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16 text-center">
            <UserCheck className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">Nenhum treinador cadastrado</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {trainers.map(t => (
            <div key={t.id} className="bg-white rounded-xl border px-4 py-3">
              {editing?.id === t.id ? (
                <div className="space-y-3">
                  <Input
                    value={editing.name}
                    onChange={e => setEditing(ed => ({ ...ed, name: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') setEditing(null); }}
                    autoFocus
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <Input
                      placeholder="WhatsApp"
                      value={editing.whatsapp || ''}
                      onChange={e => setEditing(ed => ({ ...ed, whatsapp: e.target.value }))}
                    />
                    <Input
                      placeholder="E-mail"
                      type="email"
                      value={editing.email || ''}
                      onChange={e => setEditing(ed => ({ ...ed, email: e.target.value }))}
                    />
                  </div>
                  <div className="flex gap-2 justify-end">
                    <Button variant="outline" size="sm" onClick={() => setEditing(null)}>Cancelar</Button>
                    <Button size="sm" onClick={handleSave}><Check className="w-3.5 h-3.5" /> Salvar</Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                    <UserCheck className="w-4 h-4 text-blue-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-gray-900">{t.name}</p>
                    <div className="flex gap-3 mt-0.5">
                      {t.whatsapp && (
                        <a href={`https://wa.me/${t.whatsapp.replace(/\D/g,'')}`} target="_blank" rel="noreferrer"
                          className="text-xs text-muted-foreground hover:text-green-600 flex items-center gap-1">
                          <Phone className="w-3 h-3" />{t.whatsapp}
                        </a>
                      )}
                      {t.email && (
                        <a href={`mailto:${t.email}`}
                          className="text-xs text-muted-foreground hover:text-blue-600 flex items-center gap-1">
                          <Mail className="w-3 h-3" />{t.email}
                        </a>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button onClick={() => setEditing({ id: t.id, name: t.name, whatsapp: t.whatsapp || '', email: t.email || '' })}
                      className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:bg-gray-100 hover:text-gray-700">
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => handleDelete(t)}
                      className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:bg-red-50 hover:text-red-500">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

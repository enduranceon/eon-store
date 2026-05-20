import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { PreSaleSupplier } from '@/api/entities';
import { toast } from 'sonner';

const EMPTY = {
  name: '', contact_name: '', whatsapp: '', email: '', website: '', notes: '',
};

export default function SupplierForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const isEdit = Boolean(id);

  useEffect(() => {
    if (isEdit) {
      setLoadingData(true);
      PreSaleSupplier.get(id)
        .then(setForm)
        .catch(e => toast.error('Erro ao carregar: ' + e.message))
        .finally(() => setLoadingData(false));
    }
  }, [id]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSave = async () => {
    if (!form.name.trim()) return toast.error('Nome é obrigatório');
    setSaving(true);
    try {
      if (isEdit) {
        await PreSaleSupplier.update(id, form);
        toast.success('Fornecedor atualizado!');
      } else {
        await PreSaleSupplier.create(form);
        toast.success('Fornecedor criado!');
      }
      navigate('/fornecedores');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (isEdit && loadingData) {
    return (
      <div className="max-w-lg mx-auto flex flex-col items-center justify-center py-24">
        <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-muted-foreground mt-3">Carregando fornecedor...</p>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/fornecedores')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <h2 className="text-xl font-bold">{isEdit ? 'Editar Fornecedor' : 'Novo Fornecedor'}</h2>
      </div>

      <Card>
        <CardHeader><CardTitle>Informações do fornecedor</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Nome do fornecedor *</Label>
            <Input placeholder="Ex: Woom, Marcio May..." value={form.name} onChange={e => set('name', e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label>Nome do contato</Label>
            <Input placeholder="Ex: João Silva" value={form.contact_name} onChange={e => set('contact_name', e.target.value)} className="mt-1" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>WhatsApp</Label>
              <Input placeholder="(11) 99999-9999" value={form.whatsapp} onChange={e => set('whatsapp', e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label>E-mail</Label>
              <Input type="email" placeholder="fornecedor@email.com" value={form.email} onChange={e => set('email', e.target.value)} className="mt-1" />
            </div>
          </div>
          <div>
            <Label>Site / Instagram</Label>
            <Input placeholder="https://..." value={form.website} onChange={e => set('website', e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label>Observações</Label>
            <Textarea placeholder="Prazo de entrega, condições, contato preferencial..." value={form.notes} onChange={e => set('notes', e.target.value)} className="mt-1" rows={3} />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-3 pb-6">
        <Button variant="outline" onClick={() => navigate('/fornecedores')}>Cancelar</Button>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? 'Salvando...' : isEdit ? 'Salvar alterações' : 'Criar fornecedor'}
        </Button>
      </div>
    </div>
  );
}

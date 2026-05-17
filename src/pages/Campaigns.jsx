import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Megaphone, Calendar, Building2, Search } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { PreSaleCampaign, PreSaleOrder } from '@/api/entities';
import { formatCurrency, formatDate } from '@/lib/utils';
import { toast } from 'sonner';

const STATUS_LABEL = { active: 'Ativa', ended: 'Encerrada', archived: 'Arquivada' };
const STATUS_BADGE = { active: 'success', ended: 'warning', archived: 'secondary' };

const EMPTY_FORM = { name: '', supplier: '', start_date: '', end_date: '', status: 'active', description: '' };

export default function Campaigns() {
  const [campaigns, setCampaigns] = useState([]);
  const [orders, setOrders] = useState([]);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const [c, o] = await Promise.all([PreSaleCampaign.list(), PreSaleOrder.list()]);
    setCampaigns(c);
    setOrders(o);
  };

  useEffect(() => { load(); }, []);

  const filtered = campaigns.filter(c =>
    c.name?.toLowerCase().includes(search.toLowerCase()) ||
    c.supplier?.toLowerCase().includes(search.toLowerCase())
  );

  const handleSave = async () => {
    if (!form.name.trim()) return toast.error('Nome é obrigatório');
    setSaving(true);
    try {
      await PreSaleCampaign.create(form);
      toast.success('Campanha criada!');
      setOpen(false);
      setForm(EMPTY_FORM);
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Campanhas de Pré-venda</h2>
          <p className="text-sm text-muted-foreground">{campaigns.length} campanhas cadastradas</p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="w-4 h-4" />
          Nova Campanha
        </Button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input placeholder="Buscar por nome ou fornecedor..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Megaphone className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="text-sm font-medium text-muted-foreground">Nenhuma campanha encontrada</p>
            <Button className="mt-4" onClick={() => setOpen(true)}>
              <Plus className="w-4 h-4" /> Criar primeira campanha
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(c => {
            const cOrders = orders.filter(o => o.campaign_id === c.id && o.payment_status !== 'cancelled');
            const totalSold = cOrders.reduce((acc, o) => acc + (o.total_value || 0), 0);
            const totalPaid = cOrders.filter(o => o.payment_status === 'paid').reduce((acc, o) => acc + (o.total_value || 0), 0);
            return (
              <Link key={c.id} to={`/campanhas/${c.id}`}>
                <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between mb-3">
                      <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                        <Megaphone className="w-5 h-5 text-blue-600" />
                      </div>
                      <Badge variant={STATUS_BADGE[c.status]}>{STATUS_LABEL[c.status]}</Badge>
                    </div>
                    <h3 className="font-semibold text-gray-900 mb-1">{c.name}</h3>
                    {c.supplier && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1 mb-2">
                        <Building2 className="w-3 h-3" />{c.supplier}
                      </p>
                    )}
                    {(c.start_date || c.end_date) && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1 mb-3">
                        <Calendar className="w-3 h-3" />
                        {formatDate(c.start_date)} → {formatDate(c.end_date)}
                      </p>
                    )}
                    <div className="border-t pt-3 grid grid-cols-3 gap-2 text-center">
                      <div>
                        <p className="text-xs text-muted-foreground">Pedidos</p>
                        <p className="text-sm font-semibold">{cOrders.length}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Vendido</p>
                        <p className="text-sm font-semibold text-blue-700">{formatCurrency(totalSold)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Pago</p>
                        <p className="text-sm font-semibold text-green-700">{formatCurrency(totalPaid)}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}

      {/* Modal nova campanha */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Nova Campanha de Pré-venda</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Nome da campanha *</Label>
              <Input placeholder="Ex: Pré-venda Uniforme EON 2026" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="mt-1" />
            </div>
            <div>
              <Label>Fornecedor principal</Label>
              <Input placeholder="Ex: Woom, Asics, Nike..." value={form.supplier} onChange={e => setForm(f => ({ ...f, supplier: e.target.value }))} className="mt-1" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Data de início</Label>
                <Input type="date" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} className="mt-1" />
              </div>
              <div>
                <Label>Data de encerramento</Label>
                <Input type="date" value={form.end_date} onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} className="mt-1" />
              </div>
            </div>
            <div>
              <Label>Status</Label>
              <Select value={form.status} onValueChange={v => setForm(f => ({ ...f, status: v }))}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Ativa</SelectItem>
                  <SelectItem value="ended">Encerrada</SelectItem>
                  <SelectItem value="archived">Arquivada</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Descrição / Observações</Label>
              <Textarea placeholder="Detalhes da campanha..." value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="mt-1" rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button onClick={handleSave} disabled={saving}>{saving ? 'Salvando...' : 'Criar Campanha'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

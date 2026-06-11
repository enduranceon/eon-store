import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Truck, Search, Edit, Trash2, Phone, Mail, Globe } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PreSaleSupplier, PreSaleProduct } from '@/api/entities';
import { usePageData } from '@/hooks/usePageData';
import { phoneDigitsForWhatsApp, formatPhoneDisplay } from '@/lib/phone';
import { toast } from 'sonner';

async function loadSuppliersPage() {
  const [suppliers, products] = await Promise.all([
    PreSaleSupplier.list(),
    PreSaleProduct.list(),
  ]);
  return { suppliers, products };
}

export default function Suppliers() {
  const {
    data: { suppliers, products },
    refresh,
  } = usePageData({
    key: 'suppliers:list',
    loader: loadSuppliersPage,
    initialData: { suppliers: [], products: [] },
    tags: ['presale_suppliers', 'presale_products'],
    onError: error => toast.error('Erro ao carregar fornecedores: ' + error.message),
  });
  const [search, setSearch] = useState('');
  const navigate = useNavigate();

  const filtered = suppliers.filter(s =>
    s.name?.toLowerCase().includes(search.toLowerCase()) ||
    s.contact_name?.toLowerCase().includes(search.toLowerCase())
  );

  const handleDelete = async (id, name) => {
    const hasProducts = products.some(p => p.supplier_id === id);
    if (hasProducts) return toast.error(`"${name}" tem produtos vinculados. Remova-os primeiro.`);
    if (!confirm(`Excluir fornecedor "${name}"?`)) return;
    await PreSaleSupplier.delete(id);
    toast.success('Fornecedor excluído');
    await refresh({ force: true });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Fornecedores</h2>
          <p className="text-sm text-muted-foreground">{suppliers.length} fornecedor{suppliers.length !== 1 ? 'es' : ''} cadastrado{suppliers.length !== 1 ? 's' : ''}</p>
        </div>
        <Button onClick={() => navigate('/fornecedores/novo')}>
          <Plus className="w-4 h-4" /> Novo Fornecedor
        </Button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input placeholder="Buscar fornecedor..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16 text-center">
            <Truck className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">Nenhum fornecedor encontrado</p>
            <Button className="mt-4" onClick={() => navigate('/fornecedores/novo')}>
              <Plus className="w-4 h-4" /> Cadastrar fornecedor
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(s => {
            const productCount = products.filter(p => p.supplier_id === s.id).length;
            return (
              <div key={s.id} className="bg-white rounded-xl border p-4 space-y-3 hover:shadow-sm transition-shadow">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                      <Truck className="w-5 h-5 text-blue-600" />
                    </div>
                    <div>
                      <p className="font-semibold text-gray-900">{s.name}</p>
                      {s.contact_name && <p className="text-xs text-muted-foreground">{s.contact_name}</p>}
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button size="icon" variant="ghost" onClick={() => navigate(`/fornecedores/${s.id}`)}>
                      <Edit className="w-3.5 h-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="text-red-400 hover:text-red-600" onClick={() => handleDelete(s.id, s.name)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>

                <div className="space-y-1">
                  {s.whatsapp && (
                    <a href={`https://wa.me/${phoneDigitsForWhatsApp(s.whatsapp)}`} target="_blank" rel="noreferrer"
                      className="flex items-center gap-2 text-xs text-muted-foreground hover:text-green-600 transition-colors">
                      <Phone className="w-3.5 h-3.5" /> {formatPhoneDisplay(s.whatsapp)}
                    </a>
                  )}
                  {s.email && (
                    <a href={`mailto:${s.email}`}
                      className="flex items-center gap-2 text-xs text-muted-foreground hover:text-blue-600 transition-colors">
                      <Mail className="w-3.5 h-3.5" /> {s.email}
                    </a>
                  )}
                  {s.website && (
                    <a href={s.website} target="_blank" rel="noreferrer"
                      className="flex items-center gap-2 text-xs text-muted-foreground hover:text-blue-600 transition-colors">
                      <Globe className="w-3.5 h-3.5" /> {s.website}
                    </a>
                  )}
                </div>

                {s.notes && <p className="text-xs text-muted-foreground border-t pt-2">{s.notes}</p>}

                <div className="flex items-center justify-between pt-1 border-t">
                  <span className="text-xs text-muted-foreground">
                    {productCount} produto{productCount !== 1 ? 's' : ''} vinculado{productCount !== 1 ? 's' : ''}
                  </span>
                  {productCount > 0 && (
                    <button
                      onClick={() => navigate('/produtos')}
                      className="text-xs text-blue-600 hover:underline"
                    >
                      Ver produtos →
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

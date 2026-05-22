import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, BookOpen, Search, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import ImageUpload from '@/components/shared/ImageUpload';
import { StockProduct, Product } from '@/api/entities';
import { formatCurrency } from '@/lib/utils';
import { toast } from 'sonner';

const empty = { name: '', description: '', category: '', sale_price: '', regular_price: '', cost_price: '', quantity: '', status: 'active', images: [], notes: '', product_id: null };

export default function StockProductForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);
  const [importModal, setImportModal] = useState(false);
  const [library, setLibrary] = useState([]);
  const [librarySearch, setLibrarySearch] = useState('');
  const isEdit = Boolean(id);

  useEffect(() => {
    if (isEdit) {
      StockProduct.get(id).then(p => setForm({
        ...p,
        sale_price: p.sale_price ?? '',
        regular_price: p.regular_price ?? '',
        cost_price: p.cost_price ?? '',
        quantity: p.quantity ?? '',
        images: p.images || [],
        product_id: p.product_id || null,
      })).catch(() => toast.error('Produto não encontrado'));
    }
  }, [id]);

  const set = (field, value) => setForm(f => ({ ...f, [field]: value }));

  const openImport = async () => {
    try {
      const products = await Product.list();
      setLibrary(products);
      setLibrarySearch('');
      setImportModal(true);
    } catch {
      toast.error('Erro ao carregar biblioteca');
    }
  };

  const importFromLibrary = (p) => {
    setForm(f => ({
      ...f,
      product_id: p.id,
      name: p.name || '',
      description: p.description || '',
      category: p.category || '',
      images: p.images || [],
      sale_price: p.sale_price ?? '',
      regular_price: p.regular_price ?? '',
      cost_price: p.cost_price ?? '',
      notes: p.notes || '',
    }));
    setImportModal(false);
    toast.success(`"${p.name}" importado da biblioteca!`);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return toast.error('Informe o nome do produto');
    setSaving(true);
    try {
      const payload = {
        ...form,
        sale_price: parseFloat(form.sale_price) || 0,
        regular_price: parseFloat(form.regular_price) || 0,
        cost_price: parseFloat(form.cost_price) || 0,
        quantity: parseInt(form.quantity) || 0,
      };
      if (isEdit) {
        await StockProduct.update(id, payload);
        toast.success('Produto atualizado!');
      } else {
        await StockProduct.create(payload);
        toast.success('Produto criado!');
      }
      navigate('/estoque');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const filteredLibrary = library.filter(p => {
    const q = librarySearch.toLowerCase();
    return !q || p.name?.toLowerCase().includes(q) || p.category?.toLowerCase().includes(q);
  });

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/estoque')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <h2 className="text-xl font-bold">{isEdit ? 'Editar produto' : 'Novo produto em estoque'}</h2>
      </div>

      {!isEdit && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-blue-900">Tem esse produto na biblioteca?</p>
            <p className="text-xs text-blue-700 mt-0.5">Importe e preencha tudo automaticamente.</p>
          </div>
          <Button variant="outline" className="border-blue-300 text-blue-700 hover:bg-blue-100 gap-2 shrink-0" onClick={openImport}>
            <BookOpen className="w-4 h-4" />
            Escolher da biblioteca
          </Button>
        </div>
      )}

      {form.product_id && (
        <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-2 flex items-center justify-between text-sm">
          <span className="text-green-800 font-medium">✓ Vinculado à biblioteca de produtos</span>
          <button onClick={() => set('product_id', null)} className="text-green-600 hover:text-green-800 text-xs underline">Desvincular</button>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Informações</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Nome do produto *</Label>
              <Input className="mt-1" value={form.name} onChange={e => set('name', e.target.value)} placeholder="Ex: Camiseta EON Dry-Fit" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Categoria</Label>
                <Input className="mt-1" value={form.category} onChange={e => set('category', e.target.value)} placeholder="Ex: Camisetas" />
              </div>
              <div>
                <Label>Status</Label>
                <Select value={form.status} onValueChange={v => set('status', v)}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Ativo</SelectItem>
                    <SelectItem value="inactive">Inativo</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Descrição</Label>
              <Textarea className="mt-1" value={form.description} onChange={e => set('description', e.target.value)} rows={3} placeholder="Descrição do produto..." />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Preços e Estoque</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div>
                <Label>Preço de venda (R$) *</Label>
                <Input className="mt-1" type="number" step="0.01" min="0" value={form.sale_price} onChange={e => set('sale_price', e.target.value)} placeholder="0,00" />
              </div>
              <div>
                <Label>Preço original (R$)</Label>
                <Input className="mt-1" type="number" step="0.01" min="0" value={form.regular_price} onChange={e => set('regular_price', e.target.value)} placeholder="0,00" />
              </div>
              <div>
                <Label>Custo (R$)</Label>
                <Input className="mt-1" type="number" step="0.01" min="0" value={form.cost_price} onChange={e => set('cost_price', e.target.value)} placeholder="0,00" />
              </div>
            </div>
            <div className="max-w-[160px]">
              <Label>Quantidade em estoque</Label>
              <Input className="mt-1" type="number" min="0" value={form.quantity} onChange={e => set('quantity', e.target.value)} placeholder="0" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Fotos</CardTitle></CardHeader>
          <CardContent>
            <ImageUpload value={form.images} onChange={imgs => set('images', imgs)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Observações internas</CardTitle></CardHeader>
          <CardContent>
            <Textarea value={form.notes} onChange={e => set('notes', e.target.value)} rows={3} placeholder="Anotações internas sobre o produto..." />
          </CardContent>
        </Card>

        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={() => navigate('/estoque')}>Cancelar</Button>
          <Button type="submit" disabled={saving}>{saving ? 'Salvando...' : isEdit ? 'Salvar alterações' : 'Criar produto'}</Button>
        </div>
      </form>

      {/* Modal biblioteca */}
      {importModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col shadow-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <h3 className="font-bold text-gray-900 flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-blue-600" /> Biblioteca de produtos
              </h3>
              <button onClick={() => setImportModal(false)} className="text-gray-400 hover:text-gray-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-5 py-3 border-b">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input placeholder="Buscar produto..." className="pl-9" value={librarySearch} onChange={e => setLibrarySearch(e.target.value)} autoFocus />
              </div>
            </div>
            <div className="overflow-y-auto flex-1 p-3 space-y-1">
              {filteredLibrary.length === 0 ? (
                <div className="text-center py-12 text-gray-400 text-sm">
                  {library.length === 0 ? 'Biblioteca vazia. Crie produtos em Produtos → Novo Produto.' : 'Nenhum produto encontrado.'}
                </div>
              ) : filteredLibrary.map(p => (
                <button
                  key={p.id}
                  onClick={() => importFromLibrary(p)}
                  className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-blue-50 text-left transition-colors"
                >
                  {p.images?.[0] ? (
                    <img src={p.images[0]} alt={p.name} className="w-12 h-12 rounded-lg object-cover border border-gray-100 shrink-0" />
                  ) : (
                    <div className="w-12 h-12 rounded-lg bg-gray-100 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm text-gray-900 truncate">{p.name}</p>
                    {p.category && <p className="text-xs text-gray-500">{p.category}</p>}
                    <p className="text-xs text-blue-600 font-medium mt-0.5">{formatCurrency(p.sale_price)}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

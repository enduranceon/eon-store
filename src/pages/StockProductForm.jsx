import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, BookOpen, Search, X, Link2, Link2Off } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import ImageUpload from '@/components/shared/ImageUpload';
import { StockProduct, Product } from '@/api/entities';
import { formatCurrency } from '@/lib/utils';
import { formatProductNumber } from '@/lib/sku';
import {
  normalizeStockVariations,
  stockProductQuantity,
  stockVariationLabel,
} from '@/lib/stock-variations';
import { toast } from 'sonner';

const empty = {
  name: '',
  description: '',
  category: '',
  subcategory: '',
  supplier: '',
  supplier_id: null,
  product_number: null,
  sale_price: '',
  regular_price: '',
  cost_price: '',
  quantity: '',
  status: 'active',
  show_in_store: true,
  images: [],
  variations: [],
  extras: [],
  notes: '',
  product_id: null,
};

function stockFormFromLibraryProduct(current, product) {
  return {
    ...current,
    product_id: product.id,
    name: product.name || '',
    description: product.description || '',
    category: product.category || '',
    subcategory: product.subcategory || '',
    supplier: product.supplier || '',
    supplier_id: product.supplier_id || null,
    product_number: product.product_number || null,
    images: product.images || [],
    sale_price: product.sale_price ?? '',
    regular_price: product.regular_price ?? '',
    cost_price: product.cost_price ?? '',
    variations: normalizeStockVariations(product.variations),
    extras: Array.isArray(product.extras) ? product.extras : [],
    show_in_store: current.show_in_store !== false,
    notes: product.notes || '',
  };
}

export default function StockProductForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const sourceProductId = searchParams.get('produto') || searchParams.get('product_id');
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);
  const [importModal, setImportModal] = useState(false);
  const [library, setLibrary] = useState([]);
  const [librarySearch, setLibrarySearch] = useState('');
  const importedSourceRef = useRef('');
  const isEdit = Boolean(id);
  const addingFromProduct = !isEdit && Boolean(sourceProductId || form.product_id);

  useEffect(() => {
    if (isEdit) {
        StockProduct.get(id).then(p => setForm({
          ...p,
          sale_price: p.sale_price ?? '',
          regular_price: p.regular_price ?? '',
          cost_price: p.cost_price ?? '',
          quantity: p.quantity ?? '',
          images: p.images || [],
          variations: normalizeStockVariations(p.variations),
          extras: Array.isArray(p.extras) ? p.extras : [],
          show_in_store: p.show_in_store !== false,
          product_id: p.product_id || null,
          supplier_id: p.supplier_id || null,
          product_number: p.product_number || null,
        })).catch(() => toast.error('Produto não encontrado'));
    }
  }, [id, isEdit]);

  useEffect(() => {
    if (isEdit || !sourceProductId || importedSourceRef.current === sourceProductId) return;

    let cancelled = false;
    importedSourceRef.current = sourceProductId;

    Product.get(sourceProductId)
      .then(product => {
        if (cancelled) return;
        setForm(current => stockFormFromLibraryProduct(current, product));
        toast.success(`"${product.name}" pronto para receber estoque.`);
      })
      .catch(() => {
        if (!cancelled) toast.error('Produto base não encontrado para adicionar estoque');
      });

    return () => {
      cancelled = true;
    };
  }, [isEdit, sourceProductId]);

  const set = (field, value) => setForm(f => ({ ...f, [field]: value }));

  const openImport = async () => {
    try {
      const products = await Product.list();
      setLibrary(products);
      setLibrarySearch('');
      setImportModal(true);
    } catch {
      toast.error('Erro ao carregar produtos cadastrados');
    }
  };

  const importFromLibrary = (p) => {
    setForm(f => stockFormFromLibraryProduct(f, p));
    setImportModal(false);
    toast.success(`"${p.name}" importado dos produtos cadastrados!`);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return toast.error('Informe o nome do produto');
    setSaving(true);
    try {
      const stockVariations = normalizeStockVariations(form.variations);
      const hasVariations = stockVariations.length > 0;
      const payload = {
          ...form,
          sale_price: parseFloat(form.sale_price) || 0,
          regular_price: parseFloat(form.regular_price) || 0,
          cost_price: parseFloat(form.cost_price) || 0,
          quantity: hasVariations
            ? stockProductQuantity({ variations: stockVariations })
            : parseInt(form.quantity) || 0,
          product_number: form.product_number ? Number(form.product_number) : null,
          variations: stockVariations,
          extras: Array.isArray(form.extras) ? form.extras : [],
          show_in_store: form.show_in_store !== false,
        };
      if (isEdit) {
        await StockProduct.update(id, payload);
        toast.success('Estoque salvo!');
        navigate(`/estoque?visao=stock&destaque=${id}`);
      } else {
        const saved = await StockProduct.create(payload);
        toast.success('Estoque salvo!');
        const highlight = saved?.id ? `&destaque=${saved.id}` : '';
        navigate(`/estoque?visao=stock${highlight}`);
      }
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const updateVariationQuantity = (index, value) => {
    setForm(f => {
      const variations = normalizeStockVariations(f.variations);
      variations[index] = {
        ...variations[index],
        quantity: value,
      };
      return { ...f, variations };
    });
  };

    const filteredLibrary = library.filter(p => {
      const q = librarySearch.toLowerCase();
      return !q ||
        p.name?.toLowerCase().includes(q) ||
        p.category?.toLowerCase().includes(q) ||
        p.subcategory?.toLowerCase().includes(q) ||
        p.supplier?.toLowerCase().includes(q) ||
        String(p.product_number || '').includes(q);
    });

    const variations = normalizeStockVariations(form.variations);
    const variationCount = variations.length;
    const extrasCount = Array.isArray(form.extras) ? form.extras.length : 0;
    const totalQuantity = variationCount > 0
      ? stockProductQuantity({ variations })
      : (parseInt(form.quantity) || 0);

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/estoque')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <h2 className="text-xl font-bold">
          {isEdit ? 'Editar estoque' : addingFromProduct ? 'Adicionar estoque' : 'Item avulso de estoque'}
        </h2>
      </div>

      {!isEdit && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-blue-900">
              {form.product_id ? 'Produto puxado da lista principal' : 'Esse produto já está cadastrado?'}
            </p>
            <p className="text-xs text-blue-700 mt-0.5">
              {form.product_id
                ? 'Confira preço, visibilidade no site e informe as quantidades por tamanho.'
                : 'Importe e preencha tudo automaticamente antes de ajustar o estoque.'}
            </p>
          </div>
          <Button variant="outline" className="border-blue-300 text-blue-700 hover:bg-blue-100 gap-2 shrink-0" onClick={openImport}>
            <BookOpen className="w-4 h-4" />
            {form.product_id ? 'Trocar produto' : 'Escolher produto'}
          </Button>
        </div>
      )}

        {form.product_id && (
          <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-2 flex items-center justify-between text-sm">
            <span className="text-green-800 font-medium inline-flex items-center gap-1.5">
              <Link2 className="w-3.5 h-3.5" /> Vinculado ao cadastro principal
            </span>
          <button onClick={() => set('product_id', null)} className="text-green-600 hover:text-green-800 text-xs underline">Desvincular</button>
        </div>
      )}

      {!form.product_id && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2 text-sm text-amber-800 flex items-center gap-2">
          <Link2Off className="w-4 h-4 shrink-0" />
          Produto avulso de estoque. Ele não acompanha mudanças feitas no cadastro principal.
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">
        <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Informações do item em estoque</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Nome do produto *</Label>
                <Input className="mt-1" value={form.name} onChange={e => set('name', e.target.value)} placeholder="Ex: Camiseta EON Dry-Fit" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <Label>Código</Label>
                  <Input
                    readOnly
                    className="mt-1 font-mono bg-gray-50 text-gray-600"
                    value={form.product_number ? formatProductNumber(form.product_number) : '—'}
                  />
                </div>
                <div>
                  <Label>Categoria</Label>
                  <Input className="mt-1" value={form.category} onChange={e => set('category', e.target.value)} placeholder="Ex: Camisetas" />
                </div>
                <div>
                  <Label>Subcategoria</Label>
                  <Input className="mt-1" value={form.subcategory || ''} onChange={e => set('subcategory', e.target.value)} placeholder="Ex: Regata" />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label>Fornecedor</Label>
                  <Input className="mt-1" value={form.supplier || ''} onChange={e => set('supplier', e.target.value)} placeholder="Ex: WOOM" />
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
              <label className="flex items-start gap-3 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3">
                <input
                  type="checkbox"
                  checked={form.show_in_store !== false}
                  onChange={e => set('show_in_store', e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-blue-600"
                />
                <span>
                  <span className="block text-sm font-semibold text-blue-950">Exibir na loja online</span>
                  <span className="block text-xs text-blue-700 mt-0.5">Quando ativo e com status ativo, o produto aparece no link da loja.</span>
                </span>
              </label>
              <div>
                <Label>Descrição</Label>
                <Textarea className="mt-1" value={form.description} onChange={e => set('description', e.target.value)} rows={3} placeholder="Descrição do produto..." />
              </div>
              {(variationCount > 0 || extrasCount > 0) && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border bg-gray-50 px-3 py-2">
                    <p className="text-xs text-muted-foreground">Variações do cadastro base</p>
                    <p className="text-sm font-semibold">{variationCount}</p>
                  </div>
                  <div className="rounded-lg border bg-gray-50 px-3 py-2">
                    <p className="text-xs text-muted-foreground">Extras do cadastro base</p>
                    <p className="text-sm font-semibold">{extrasCount}</p>
                  </div>
                </div>
              )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Preços e quantidade</CardTitle></CardHeader>
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
            {variationCount > 0 ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>Quantidade por tamanho/variação</Label>
                  <span className="text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-100 rounded-full px-2 py-1">
                    Total: {totalQuantity} un.
                  </span>
                </div>
                <div className="grid gap-2">
                  {variations.map((variation, index) => (
                    <div key={`${stockVariationLabel(variation)}-${index}`} className="grid grid-cols-[1fr,110px] gap-3 items-center rounded-xl border bg-gray-50 px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold truncate">{stockVariationLabel(variation)}</p>
                        {variation.sku && <p className="text-[11px] text-muted-foreground font-mono">{variation.sku}</p>}
                      </div>
                      <Input
                        type="number"
                        min="0"
                        value={variation.quantity ?? 0}
                        onChange={e => updateVariationQuantity(index, e.target.value)}
                        className="h-9 text-right"
                      />
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="max-w-[160px]">
                <Label>Quantidade em estoque</Label>
                <Input className="mt-1" type="number" min="0" value={form.quantity} onChange={e => set('quantity', e.target.value)} placeholder="0" />
              </div>
            )}
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
          <Button type="submit" disabled={saving}>{saving ? 'Salvando estoque...' : 'Salvar estoque'}</Button>
        </div>
      </form>

      {/* Modal de produtos cadastrados */}
      {importModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col shadow-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <h3 className="font-bold text-gray-900 flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-blue-600" /> Produtos cadastrados
              </h3>
              <button onClick={() => setImportModal(false)} className="text-gray-400 hover:text-gray-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-5 py-3 border-b">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input placeholder="Buscar nome, código, categoria ou fornecedor..." className="pl-9" value={librarySearch} onChange={e => setLibrarySearch(e.target.value)} autoFocus />
              </div>
            </div>
            <div className="overflow-y-auto flex-1 p-3 space-y-1">
              {filteredLibrary.length === 0 ? (
                <div className="text-center py-12 text-gray-400 text-sm">
                  {library.length === 0 ? 'Nenhum produto base cadastrado. Crie um produto de pré-venda ou um item em estoque.' : 'Nenhum produto encontrado.'}
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
                      <p className="text-xs text-gray-500">
                        {p.product_number ? `${formatProductNumber(p.product_number)} · ` : ''}
                        {[p.category, p.subcategory, p.supplier].filter(Boolean).join(' · ') || 'Sem classificação'}
                      </p>
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

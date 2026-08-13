import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Wand2, ChevronDown, ChevronUp, Hash } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import ImageUpload from '@/components/shared/ImageUpload';
import ProductStockProfile from '@/components/shared/ProductStockProfile';
import { formatSku, formatProductNumber } from '@/lib/sku';
import { normalizeStockVariations, stockProductQuantity, stockVariationLabel, stockVariationQuantity } from '@/lib/stock-variations';
import { PreSaleProduct, PreSaleCampaign, PreSaleSupplier, PreSaleCategory, Product, StockProduct } from '@/api/entities';
import { formatCurrency, cn } from '@/lib/utils';
import { normalizeCampaignSelection } from '@/lib/campaignLinks';
import { toast } from 'sonner';

// ─── Opções pré-definidas ───────────────────────────────────────────────────
const SIZES_LETTER = ['PP', 'P', 'M', 'G', 'GG', 'XGG', '2XG', '3XG'];
const SIZES_NUMERIC = ['34', '36', '38', '40', '42', '44', '46', '48'];
const GENDERS = ['Masculino', 'Feminino', 'Unissex'];

// ─── SKU: padrão NNNN-SIZE-GENDER ────────────────────────────────────────────
// O SKU é gerado a partir de product_number (gerado pelo banco) + size + gender.
// Não é editável manualmente: garante unicidade e padronização.

const EMPTY = {
  name: '', product_number: null, supplier: '', sale_price: '', regular_price: '', cost_price: '',
  extra_cost: '', extra_cost_description: '',
  category: '', subcategory: '', description: '', images: [], supplier_id: '', product_id: null,
  status: 'active', campaign_ids: [], variations: [], extras: [], notes: '',
};

function presaleFormFromCatalogProduct(current, product) {
  return {
    ...current,
    product_id: product.id,
    product_number: product.product_number || null,
    name: product.name || '',
    description: product.description || '',
    category: product.category || '',
    subcategory: product.subcategory || '',
    supplier: product.supplier || '',
    supplier_id: product.supplier_id || '',
    images: Array.isArray(product.images) ? product.images : [],
    sale_price: String(product.sale_price ?? ''),
    regular_price: String(product.regular_price ?? ''),
    cost_price: String(product.cost_price ?? ''),
    extra_cost: String(product.extra_cost ?? ''),
    variations: Array.isArray(product.variations) ? product.variations : [],
    extras: Array.isArray(product.extras) ? product.extras : [],
  };
}

async function syncLinkedStockProduct(productId, product) {
  const stockProduct = (await StockProduct.list()).find(item => item.product_id === productId);
  if (!stockProduct) return { needsStockReconciliation: false };

  const payload = {
    name: product.name,
    description: product.description || null,
    category: product.category || null,
    subcategory: product.subcategory || null,
    images: product.images || [],
    sale_price: product.sale_price,
    cost_price: product.cost_price,
    supplier: product.supplier || null,
    supplier_id: product.supplier_id || null,
    notes: product.notes || null,
    status: product.status,
    extras: product.extras || [],
  };

  payload.regular_price = product.regular_price ?? null;
  if (product.product_number) payload.product_number = product.product_number;

  const catalogVariations = normalizeStockVariations(product.variations);
  const stockVariations = normalizeStockVariations(stockProduct.variations);
  const stockVariationsByKey = new Map(
    stockVariations.map(variation => [variation.sku || stockVariationLabel(variation), variation])
  );
  const hasSameVariationSchema = catalogVariations.length === stockVariations.length &&
    catalogVariations.every(variation => stockVariationsByKey.has(variation.sku || stockVariationLabel(variation)));

  if (hasSameVariationSchema) {
    payload.variations = catalogVariations.map(variation => {
      const stockVariation = stockVariationsByKey.get(variation.sku || stockVariationLabel(variation));
      return { ...variation, quantity: stockVariationQuantity(stockVariation) };
    });
  } else if (stockProductQuantity(stockProduct) === 0) {
    payload.variations = catalogVariations;
  } else {
    return { needsStockReconciliation: true };
  }

  await StockProduct.update(stockProduct.id, payload);
  return { needsStockReconciliation: false };
}

// ─── Chip de seleção múltipla ────────────────────────────────────────────────
function Chip({ label, selected, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-3 py-1.5 rounded-full text-xs font-medium border transition-colors',
        selected
          ? 'bg-blue-600 text-white border-blue-600'
          : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400 hover:text-blue-600'
      )}
    >
      {label}
    </button>
  );
}

export default function ProductForm({ mode = 'presale' }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isPresale = mode === 'presale';
  const isEdit = Boolean(id);
  const sourceProductId = searchParams.get('produto') || searchParams.get('product_id');
  const stockTabRequested = searchParams.get('aba') === 'estoque';
  const [form, setForm] = useState(EMPTY);
  const [campaigns, setCampaigns] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [categories, setCategories] = useState([]);
  const [catalogProducts, setCatalogProducts] = useState([]);
  const [saving, setSaving] = useState(false);
  const [loadingProduct, setLoadingProduct] = useState(isEdit);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Estado do gerador rápido
  const [showGenerator, setShowGenerator] = useState(false);
  const [genSizes, setGenSizes] = useState([]);
  const [genGenders, setGenGenders] = useState([]);
  const [genSizeType, setGenSizeType] = useState('letter'); // 'letter' | 'numeric' | 'custom'
  const [genCustomSizes, setGenCustomSizes] = useState('');

  useEffect(() => {
    PreSaleCampaign.list().then(setCampaigns);
    PreSaleSupplier.list().then(setSuppliers);
    PreSaleCategory.list().then(setCategories);
    if (isEdit) {
      const entity = isPresale ? PreSaleProduct : Product;
      entity.get(id).then(async p => {
        const images = p.images || (p.image ? [p.image] : []);
        let supplier_id = p.supplier_id || '';
        if (!supplier_id && p.supplier) {
          const all = await PreSaleSupplier.list();
          const found = all.find(s => s.name === p.supplier);
          if (found) supplier_id = found.id;
        }
        setForm({
          ...p,
          supplier_id,
          sale_price: String(p.sale_price || ''),
          regular_price: String(p.regular_price || ''),
          cost_price: String(p.cost_price || ''),
          extra_cost: String(p.extra_cost || ''),
          variations: Array.isArray(p.variations) ? p.variations : [],
          extras: Array.isArray(p.extras) ? p.extras : [],
          images,
          campaign_ids: isPresale ? normalizeCampaignSelection(p) : [],
        });
        setHasUnsavedChanges(false);
      }).catch(e => {
        toast.error('Erro ao carregar produto: ' + e.message);
      }).finally(() => {
        setLoadingProduct(false);
      });
    }
  }, [id, isEdit, isPresale]);

  useEffect(() => {
    if (!isPresale || isEdit) return;
    Product.list()
      .then(setCatalogProducts)
      .catch(error => toast.error('Erro ao carregar produtos cadastrados: ' + error.message));
  }, [isEdit, isPresale]);

  useEffect(() => {
    if (!isPresale || isEdit || !sourceProductId) return;
    Product.get(sourceProductId)
      .then(product => setForm(current => presaleFormFromCatalogProduct(current, product)))
      .catch(() => toast.error('Produto base não encontrado para criar a pré-venda'));
  }, [isEdit, isPresale, sourceProductId]);

  const salePrice = parseFloat(form.sale_price) || 0;
  const regularPrice = parseFloat(form.regular_price) || 0;
  const costPrice = parseFloat(form.cost_price) || 0;
  const extraCost = parseFloat(form.extra_cost) || 0;
  const totalCost = costPrice + extraCost;
  const profit = salePrice - totalCost;
  const margin = salePrice > 0 ? (profit / salePrice) * 100 : 0;
  const discount = regularPrice > salePrice ? Math.round((1 - salePrice / regularPrice) * 100) : 0;

  const setField = (k, v) => {
    setHasUnsavedChanges(true);
    setForm(f => ({ ...f, [k]: v }));
  };

  // Gerador: cria variações a partir de tamanho + gênero
  const generateVariations = () => {
    const sizes = genSizeType === 'custom'
      ? genCustomSizes.split(',').map(s => s.trim()).filter(Boolean)
      : genSizes;

    if (sizes.length === 0 && genGenders.length === 0) {
      return toast.error('Selecione ao menos um tamanho ou gênero');
    }

    const existing = form.variations || [];
    const toAdd = [];

    const pn = form.product_number;
    if (sizes.length > 0 && genGenders.length > 0) {
      // Combinação tamanho × gênero
      for (const gender of genGenders) {
        for (const size of sizes) {
          const name = `${gender} - ${size}`;
          if (!existing.find(v => v.name === name)) {
            toAdd.push({ name, sku: formatSku(pn, size, gender), gender, size, sale_price: '', regular_price: '', cost_price: '' });
          }
        }
      }
    } else if (sizes.length > 0) {
      for (const size of sizes) {
        if (!existing.find(v => v.size === size && !v.gender)) {
          toAdd.push({ name: size, sku: formatSku(pn, size, ''), size, gender: '', sale_price: '', regular_price: '', cost_price: '' });
        }
      }
    } else {
      for (const gender of genGenders) {
        if (!existing.find(v => v.gender === gender && !v.size)) {
          toAdd.push({ name: gender, sku: formatSku(pn, '', gender), gender, size: '', sale_price: '', regular_price: '', cost_price: '' });
        }
      }
    }

    if (toAdd.length === 0) return toast.info('Essas variações já existem');
    setHasUnsavedChanges(true);
    setForm(f => ({ ...f, variations: [...(f.variations || []), ...toAdd] }));
    toast.success(`${toAdd.length} variações adicionadas!`);
    setGenSizes([]);
    setGenGenders([]);
    setShowGenerator(false);
  };

  const toggleSize = (s) => setGenSizes(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);
  const toggleGender = (g) => setGenGenders(prev => prev.includes(g) ? prev.filter(x => x !== g) : [...prev, g]);

  const addVariation = () => {
    setHasUnsavedChanges(true);
    setForm(f => ({
      ...f,
      variations: [...(f.variations || []), { name: '', sku: formatSku(f.product_number, '', ''), gender: '', size: '', sale_price: '', regular_price: '', cost_price: '' }],
    }));
  };

  const updateVariation = (i, k, v) => {
    setHasUnsavedChanges(true);
    setForm(f => {
      const vars = [...(f.variations || [])];
      vars[i] = { ...vars[i], [k]: v };
      // Atualiza nome automaticamente se veio do gerador
      if ((k === 'gender' || k === 'size') && vars[i].gender !== undefined) {
        const g = vars[i].gender;
        const s = vars[i].size;
        if (g && s) vars[i].name = `${g} - ${s}`;
        else if (g) vars[i].name = g;
        else if (s) vars[i].name = s;
      }
      // Re-gera SKU automaticamente quando size/gender mudam (não editável manualmente)
      if (k === 'gender' || k === 'size') {
        vars[i].sku = formatSku(f.product_number, vars[i].size || '', vars[i].gender || '');
      }
      return { ...f, variations: vars };
    });
  };

  const removeVariation = (i) => {
    setHasUnsavedChanges(true);
    setForm(f => ({ ...f, variations: f.variations.filter((_, idx) => idx !== i) }));
  };

  const addExtra = () => {
    setHasUnsavedChanges(true);
    setForm(f => ({ ...f, extras: [...(f.extras || []), { name: '', price: '', required: false }] }));
  };
  const updateExtra = (i, k, v) => {
    setHasUnsavedChanges(true);
    setForm(f => { const ex = [...(f.extras || [])]; ex[i] = { ...ex[i], [k]: v }; return { ...f, extras: ex }; });
  };
  const removeExtra = (i) => {
    setHasUnsavedChanges(true);
    setForm(f => ({ ...f, extras: f.extras.filter((_, idx) => idx !== i) }));
  };

  const handleSave = async () => {
    if (!form.name.trim()) return toast.error('Nome é obrigatório');
    if (!form.sale_price) return toast.error('Preço de venda é obrigatório');
    setSaving(true);
    try {
      let variations = (form.variations || []).map(v => ({
        ...v,
        sale_price: isPresale ? parseFloat(v.sale_price) || null : null,
        regular_price: isPresale ? parseFloat(v.regular_price) || null : null,
        cost_price: isPresale ? parseFloat(v.cost_price) || null : null,
      }));
      const extras = (form.extras || [])
        .filter(e => e.name?.trim())
        .map(e => ({ name: e.name.trim(), price: parseFloat(e.price) || 0, required: Boolean(e.required) }));

      // Produto-base é independente de estoque e pré-venda.
      const libraryPayload = {
        name: form.name, description: form.description,
        category: form.category, subcategory: form.subcategory,
        images: form.images || [],
        sale_price: salePrice, regular_price: null,
        cost_price: costPrice, extra_cost: extraCost,
        supplier: form.supplier, supplier_id: form.supplier_id || null,
        notes: form.notes, status: form.status,
        variations, extras,
      };
      if (!isPresale) {
        let savedProduct;
        if (isEdit) {
          savedProduct = await Product.update(id, libraryPayload);
          try {
            const stockSync = await syncLinkedStockProduct(savedProduct.id, savedProduct);
            if (stockSync.needsStockReconciliation) {
              toast.warning('Dados salvos. Há saldo nos tamanhos antigos; ajuste esse saldo antes de trocar os tamanhos no estoque.');
            }
          } catch (syncError) {
            console.error('Não foi possível espelhar os dados no estoque', syncError);
            toast.warning('Produto salvo, mas a loja ainda não recebeu as alterações. Tente salvar novamente.');
          }
        } else {
          const product = await Product.create(libraryPayload);
          savedProduct = product;
          if (product.product_number && variations.length > 0) {
            variations = variations.map(v => ({
              ...v,
              sku: formatSku(product.product_number, v.size || '', v.gender || ''),
            }));
            await Product.update(product.id, { variations });
          }
        }
        setHasUnsavedChanges(false);
        toast.success(isEdit ? 'Produto atualizado!' : 'Produto criado!');
        navigate(`/produtos/${savedProduct.id}${isEdit ? '' : '?aba=estoque'}`);
        return;
      }

      if (!form.product_id) {
        toast.error('Escolha o produto base desta pré-venda');
        return;
      }

      // Pré-venda é uma oferta vinculada a um produto-base já existente.
      const payload = {
        ...form,
        product_id: form.product_id,
        product_number: form.product_number,
        campaign_id: null,
        sale_price: salePrice, regular_price: regularPrice || null,
        cost_price: costPrice, extra_cost: extraCost,
        total_cost: totalCost, profit_per_unit: profit,
        margin_percent: margin, discount_percent: discount || null,
        variations, extras,
      };
      if (isEdit) {
        await PreSaleProduct.update(id, payload);
        toast.success('Produto atualizado!');
      } else {
        await PreSaleProduct.create(payload);
        toast.success('Produto criado!');
      }
      navigate('/produtos/pre-venda');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const variations = form.variations || [];
  const showProductProfile = !isPresale && isEdit;
  const activeSection = stockTabRequested ? 'stock' : 'details';

  const selectProfileSection = value => {
    if (value === 'stock' && hasUnsavedChanges) {
      toast.error('Salve as alterações dos tamanhos antes de abrir o estoque');
      return;
    }
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      if (value === 'stock') next.set('aba', 'estoque');
      else next.delete('aba');
      return next;
    });
  };

  if (isEdit && loadingProduct) {
    return (
      <div className="max-w-2xl mx-auto flex flex-col items-center justify-center py-24">
        <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-muted-foreground mt-3">Carregando produto...</p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(isPresale ? '/produtos/pre-venda' : '/produtos')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h2 className="text-xl font-bold">
            {isPresale
              ? (isEdit ? 'Editar pré-venda' : 'Criar pré-venda')
              : (isEdit ? (form.name || 'Produto') : 'Novo produto')}
          </h2>
          {showProductProfile && <p className="text-sm text-muted-foreground">Perfil do produto</p>}
        </div>
      </div>

      {showProductProfile && (
        <Tabs value={activeSection} onValueChange={selectProfileSection}>
          <TabsList>
            <TabsTrigger value="details">Dados</TabsTrigger>
            <TabsTrigger value="stock">Estoque e loja</TabsTrigger>
          </TabsList>
        </Tabs>
      )}

      {showProductProfile && activeSection === 'stock' && <ProductStockProfile productId={id} />}

      {(!showProductProfile || activeSection === 'details') && <>

      {isPresale && !isEdit && (
        <Card>
          <CardHeader><CardTitle>Produto base</CardTitle></CardHeader>
          <CardContent>
            <Select
              value={form.product_id || ''}
              onValueChange={productId => {
                const product = catalogProducts.find(item => item.id === productId);
                if (product) setForm(current => presaleFormFromCatalogProduct(current, product));
              }}
            >
              <SelectTrigger><SelectValue placeholder="Escolha um produto cadastrado" /></SelectTrigger>
              <SelectContent>
                {catalogProducts.map(product => (
                  <SelectItem key={product.id} value={product.id}>
                    {product.product_number ? `${formatProductNumber(product.product_number)} · ` : ''}{product.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      )}

      {/* Informações básicas */}
      <Card>
          <CardHeader><CardTitle>{isPresale ? 'Informações da pré-venda' : 'Informações do produto'}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Fotos do produto <span className="text-xs text-muted-foreground font-normal">(até 3 · a primeira é a principal)</span></Label>
            <div className="mt-1">
              <ImageUpload
                value={form.images || []}
                onChange={v => setField('images', v)}
              />
            </div>
          </div>
          <div className="grid grid-cols-[1fr,160px] gap-4">
            <div>
              <Label>Nome do produto *</Label>
              <Input placeholder="Ex: Camiseta EON Dri-Fit" value={form.name} onChange={e => setField('name', e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label className="flex items-center gap-1.5">
                <Hash className="w-3.5 h-3.5" />
                Código do produto
                <span className="text-xs text-muted-foreground font-normal">(automático)</span>
              </Label>
              <Input
                readOnly
                value={form.product_number ? formatProductNumber(form.product_number) : '— gerado ao salvar —'}
                className="mt-1 font-mono bg-gray-50 cursor-not-allowed text-gray-600"
                title="Número sequencial único — gerado pelo sistema"
              />
              <p className="text-[11px] text-blue-600 mt-0.5">
                ✦ SKU das variações: <span className="font-mono">{form.product_number ? formatProductNumber(form.product_number) : 'NNNN'}-TAM-G</span>
                {' '}(ex: <span className="font-mono">{form.product_number ? formatSku(form.product_number, 'M', 'Masculino') : '0042-M-M'}</span>)
              </p>
            </div>
          </div>
          <div className={cn('grid gap-4', isPresale ? 'grid-cols-2' : 'grid-cols-1')}>
            <div>
              <Label>Categoria</Label>
              <Select
                value={form.category || '_none'}
                onValueChange={v => {
                  setField('category', v === '_none' ? '' : v);
                  setField('subcategory', '');
                }}
              >
                <SelectTrigger className="mt-1"><SelectValue placeholder="Selecionar..." /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">Sem categoria</SelectItem>
                  {categories.map(c => <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
              {categories.length === 0 && (
                <a href="/categorias" className="text-xs text-blue-600 hover:underline mt-1 inline-block">+ Cadastrar categorias</a>
              )}
            </div>
            <div>
              <Label>Subcategoria</Label>
              {(() => {
                const cat = categories.find(c => c.name === form.category);
                const subs = cat?.subcategories || [];
                return subs.length > 0 ? (
                  <Select value={form.subcategory || '_none'} onValueChange={v => setField('subcategory', v === '_none' ? '' : v)}>
                    <SelectTrigger className="mt-1"><SelectValue placeholder="Selecionar..." /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">Sem subcategoria</SelectItem>
                      {subs.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    placeholder={form.category ? 'Nenhuma subcategoria cadastrada' : 'Selecione uma categoria antes'}
                    value={form.subcategory}
                    onChange={e => setField('subcategory', e.target.value)}
                    className="mt-1"
                    disabled={!form.category || subs.length > 0}
                  />
                );
              })()}
            </div>
          </div>
          <div className={cn('grid gap-4', isPresale ? 'grid-cols-2' : 'grid-cols-1')}>
            <div>
              <Label>Fornecedor</Label>
              <Select
                value={form.supplier_id || '_none'}
                onValueChange={v => {
                  if (v === '_none') {
                    setField('supplier_id', '');
                    setField('supplier', '');
                  } else {
                    const s = suppliers.find(s => s.id === v);
                    setField('supplier_id', v);
                    setField('supplier', s?.name || '');
                  }
                }}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Selecionar fornecedor..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">Sem fornecedor</SelectItem>
                  {suppliers.map(s => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {suppliers.length === 0 && (
                <a href="/fornecedores/novo" className="text-xs text-blue-600 hover:underline mt-1 inline-block">
                  + Cadastrar fornecedor
                </a>
              )}
            </div>
            {isPresale && <div>
              <Label>Coleções / campanhas (opcional)</Label>
              {campaigns.length === 0 ? (
                <p className="text-xs text-muted-foreground mt-2">Nenhuma campanha cadastrada ainda.</p>
              ) : (
                <div className="mt-1.5 space-y-1.5 max-h-36 overflow-y-auto border rounded-lg p-2">
                  {campaigns.map(c => {
                    const checked = (form.campaign_ids || []).includes(c.id);
                    return (
                      <label key={c.id} className="flex items-center gap-2.5 px-1 py-1 rounded-md hover:bg-gray-50 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            const ids = form.campaign_ids || [];
                            setField('campaign_ids', checked ? ids.filter(x => x !== c.id) : [...ids, c.id]);
                          }}
                          className="w-4 h-4 rounded accent-blue-600"
                        />
                        <span className="text-sm text-gray-700">{c.name}</span>
                        {c.status === 'active' && <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">Ativa</span>}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>}
          </div>
          <div>
            <Label>Status</Label>
            <Select value={form.status} onValueChange={v => setField('status', v)}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Ativo</SelectItem>
                <SelectItem value="inactive">Inativo</SelectItem>
                {isPresale && <SelectItem value="pre_sale_closed">Pré-venda encerrada</SelectItem>}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Preços e custos */}
      <Card>
        <CardHeader><CardTitle>{isPresale ? 'Preço e custos da pré-venda' : 'Preço e custos'}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className={cn('grid gap-4', isPresale ? 'grid-cols-2' : 'max-w-xs')}>
            <div>
              <Label>{isPresale ? 'Preço pré-venda (R$) *' : 'Preço de venda (R$) *'}</Label>
              <Input type="number" step="0.01" min="0" placeholder="0,00" value={form.sale_price} onChange={e => setField('sale_price', e.target.value)} className="mt-1" />
              <p className="text-xs text-muted-foreground mt-1">{isPresale ? 'O que o cliente paga na pré-venda' : 'Preço padrão para as vendas'}</p>
            </div>
            {isPresale && <div>
              <Label>Preço normal depois da pré-venda (R$)</Label>
              <Input type="number" step="0.01" min="0" placeholder="0,00" value={form.regular_price} onChange={e => setField('regular_price', e.target.value)} className="mt-1" />
              <p className="text-xs text-muted-foreground mt-1">Preço praticado quando a pré-venda terminar</p>
            </div>}
          </div>

          {isPresale && discount > 0 && (
            <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-4 py-2.5">
              <span className="text-green-700 font-semibold text-sm">{discount}% OFF na pré-venda</span>
              <span className="text-green-600 text-xs">· cliente economiza {formatCurrency(regularPrice - salePrice)}</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Custo do produto (R$)</Label>
              <Input type="number" step="0.01" min="0" placeholder="0,00" value={form.cost_price} onChange={e => setField('cost_price', e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label>Custo extra (frete, embalagem...)</Label>
              <Input type="number" step="0.01" min="0" placeholder="0,00" value={form.extra_cost} onChange={e => setField('extra_cost', e.target.value)} className="mt-1" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Descrição do custo extra</Label>
              <Input placeholder="Ex: frete, embalagem, custo extra" value={form.extra_cost_description} onChange={e => setField('extra_cost_description', e.target.value)} className="mt-1" />
            </div>
          </div>

          {salePrice > 0 && (
            <div className="rounded-lg bg-gray-50 border p-4 grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-xs text-muted-foreground">Custo total</p>
                <p className="text-sm font-semibold text-red-600">{formatCurrency(totalCost)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Lucro/unidade</p>
                <p className={`text-sm font-semibold ${profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>{formatCurrency(profit)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Margem</p>
                <p className={`text-sm font-semibold ${margin >= 0 ? 'text-green-600' : 'text-red-600'}`}>{margin.toFixed(1)}%</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Variações */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Variações</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">Tamanho, gênero, cor ou modelo. Preço/custo em branco = usa o padrão acima.</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setShowGenerator(g => !g)}>
                <Wand2 className="w-3.5 h-3.5" />
                Gerar
                {showGenerator ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </Button>
              <Button size="sm" variant="outline" onClick={addVariation}>
                <Plus className="w-3.5 h-3.5" /> Manual
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">

          {/* Gerador rápido */}
          {showGenerator && (
            <div className="border rounded-lg p-4 bg-blue-50 space-y-4">
              <p className="text-sm font-medium text-blue-800">Gerador automático de variações</p>

              {/* Tipo de tamanho */}
              <div>
                <Label className="text-xs text-blue-700 mb-2 block">Tipo de tamanho</Label>
                <div className="flex gap-2">
                  {[['letter', 'Letras (P/M/G)'], ['numeric', 'Números (38/40/42)'], ['custom', 'Personalizado']].map(([v, l]) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => { setGenSizeType(v); setGenSizes([]); }}
                      className={cn(
                        'px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                        genSizeType === v ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400'
                      )}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>

              {/* Tamanhos */}
              {genSizeType !== 'custom' && (
                <div>
                  <Label className="text-xs text-blue-700 mb-2 block">Tamanhos</Label>
                  <div className="flex flex-wrap gap-2">
                    {(genSizeType === 'letter' ? SIZES_LETTER : SIZES_NUMERIC).map(s => (
                      <Chip key={s} label={s} selected={genSizes.includes(s)} onClick={() => toggleSize(s)} />
                    ))}
                  </div>
                </div>
              )}

              {genSizeType === 'custom' && (
                <div>
                  <Label className="text-xs text-blue-700 mb-1 block">Tamanhos personalizados (separados por vírgula)</Label>
                  <Input
                    placeholder="Ex: 44, 46, 48 ou Infantil P, Infantil M"
                    value={genCustomSizes}
                    onChange={e => setGenCustomSizes(e.target.value)}
                    className="bg-white"
                  />
                </div>
              )}

              {/* Gênero */}
              <div>
                <Label className="text-xs text-blue-700 mb-2 block">Gênero (opcional)</Label>
                <div className="flex gap-2">
                  {GENDERS.map(g => (
                    <Chip key={g} label={g} selected={genGenders.includes(g)} onClick={() => toggleGender(g)} />
                  ))}
                </div>
              </div>

              {/* Preview */}
              {(genSizes.length > 0 || genGenders.length > 0 || genCustomSizes) && (
                <div className="bg-white rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground mb-1.5">Variações que serão criadas:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(() => {
                      const sizes = genSizeType === 'custom'
                        ? genCustomSizes.split(',').map(s => s.trim()).filter(Boolean)
                        : genSizes;
                      if (sizes.length > 0 && genGenders.length > 0) {
                        return genGenders.flatMap(g => sizes.map(s => (
                          <span key={`${g}-${s}`} className="text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full">{g} - {s}</span>
                        )));
                      }
                      if (sizes.length > 0) return sizes.map(s => <span key={s} className="text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full">{s}</span>);
                      return genGenders.map(g => <span key={g} className="text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full">{g}</span>);
                    })()}
                  </div>
                </div>
              )}

              <Button size="sm" onClick={generateVariations} className="w-full">
                <Wand2 className="w-3.5 h-3.5" /> Gerar variações
              </Button>
            </div>
          )}

          {/* Lista de variações */}
          {variations.length === 0 && !showGenerator && (
            <p className="text-sm text-muted-foreground text-center py-6">
              Nenhuma variação. Use <strong>Gerar</strong> para criar por tamanho/gênero ou <strong>Manual</strong> para adicionar individualmente.
            </p>
          )}

          {variations.length > 0 && (
            <div className="space-y-2">
              {/* Cabeçalho da tabela */}
              <div className={cn(
                'grid gap-2 text-xs font-medium text-muted-foreground px-1',
                isPresale ? 'grid-cols-[1fr,90px,90px,80px,80px,80px,80px,36px]' : 'grid-cols-[1fr,90px,90px,80px,36px]'
              )}>
                <span>Nome / Variação</span>
                <span>SKU</span>
                <span>Gênero</span>
                <span>Tam.</span>
                {isPresale && <>
                  <span className="text-right">Pré-venda</span>
                  <span className="text-right">Normal</span>
                  <span className="text-right">Custo</span>
                </>}
                <span />
              </div>

              {variations.map((v, i) => (
                <div key={i} className={cn(
                  'grid gap-2 items-center p-2 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-200',
                  isPresale ? 'grid-cols-[1fr,90px,90px,80px,80px,80px,80px,36px]' : 'grid-cols-[1fr,90px,90px,80px,36px]'
                )}>
                  <Input
                    placeholder="Ex: Fem. - M, Azul GG..."
                    value={v.name}
                    onChange={e => updateVariation(i, 'name', e.target.value)}
                    className="h-8 text-sm"
                  />
                  <Input
                    readOnly
                    placeholder="—"
                    value={v.sku ?? ''}
                    className="h-8 text-xs font-mono bg-gray-50 cursor-not-allowed text-gray-600"
                    title="SKU gerado automaticamente a partir do código do produto + tamanho + gênero"
                  />
                  <Select value={v.gender || '_none'} onValueChange={val => updateVariation(i, 'gender', val === '_none' ? '' : val)}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Gênero" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">—</SelectItem>
                      {GENDERS.map(g => <SelectItem key={g} value={g}>{g}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Select value={v.size || '_none'} onValueChange={val => updateVariation(i, 'size', val === '_none' ? '' : val)}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Tam." /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">—</SelectItem>
                      <SelectItem value="_group_letter" disabled className="text-xs text-muted-foreground font-semibold">── Letras ──</SelectItem>
                      {SIZES_LETTER.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                      <SelectItem value="_group_num" disabled className="text-xs text-muted-foreground font-semibold">── Números ──</SelectItem>
                      {SIZES_NUMERIC.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {isPresale && <>
                    <Input
                      type="number" step="0.01" placeholder="Padrão"
                      value={v.sale_price ?? ''}
                      onChange={e => updateVariation(i, 'sale_price', e.target.value)}
                      className="h-8 text-sm text-right"
                    />
                    <Input
                      type="number" step="0.01" placeholder="Padrão"
                      value={v.regular_price ?? ''}
                      onChange={e => updateVariation(i, 'regular_price', e.target.value)}
                      className="h-8 text-sm text-right"
                    />
                    <Input
                      type="number" step="0.01" placeholder="Padrão"
                      value={v.cost_price ?? ''}
                      onChange={e => updateVariation(i, 'cost_price', e.target.value)}
                      className="h-8 text-sm text-right"
                    />
                  </>}
                  <Button size="icon" variant="ghost" onClick={() => removeVariation(i)} className="h-8 w-8 text-red-400 hover:text-red-700">
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}

              <p className="text-xs text-muted-foreground px-1 pt-1">
                {variations.length} variação{variations.length !== 1 ? 'ões' : ''} cadastrada{variations.length !== 1 ? 's' : ''}.
                {isPresale
                  ? 'Preço/custo em branco = usa o padrão da pré-venda.'
                  : 'O preço e o custo definidos acima valem para todas as variações.'}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Adicionais opcionais */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Adicionais opcionais</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">Itens que o cliente pode adicionar ao produto, com custo extra. Ex: personalização de nome, numeração.</p>
            </div>
            <Button size="sm" variant="outline" onClick={addExtra}>
              <Plus className="w-3.5 h-3.5" /> Adicionar
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {(form.extras || []).length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">Nenhum adicional cadastrado. Clique em <strong>Adicionar</strong> para criar.</p>
          ) : (
            <>
              <div className="grid grid-cols-[1fr,120px,auto,36px] gap-2 text-xs font-medium text-muted-foreground px-1">
                <span>Nome do adicional</span>
                <span className="text-right">Preço (R$)</span>
                <span className="text-center">Obrigatório</span>
                <span />
              </div>
              {(form.extras || []).map((extra, i) => (
                <div key={i} className="grid grid-cols-[1fr,120px,auto,36px] gap-2 items-center p-2 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-200">
                  <Input
                    placeholder="Ex: Personalização de nome"
                    value={extra.name}
                    onChange={e => updateExtra(i, 'name', e.target.value)}
                    className="h-8 text-sm"
                  />
                  <Input
                    type="number" step="0.01" min="0" placeholder="0,00"
                    value={extra.price}
                    onChange={e => updateExtra(i, 'price', e.target.value)}
                    className="h-8 text-sm text-right"
                  />
                  <div className="flex items-center justify-center">
                    <label className="flex items-center gap-1.5 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={Boolean(extra.required)}
                        onChange={e => updateExtra(i, 'required', e.target.checked)}
                        className="w-4 h-4 rounded accent-blue-600"
                      />
                      <span className="text-xs text-gray-600">Sim</span>
                    </label>
                  </div>
                  <Button size="icon" variant="ghost" onClick={() => removeExtra(i)} className="h-8 w-8 text-red-400 hover:text-red-700">
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
              <p className="text-xs text-muted-foreground px-1">
                Adicionais <strong>obrigatórios</strong> bloqueiam o checkout até serem selecionados. Os opcionais ficam à escolha do cliente.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* Observações */}
      <div>
        <Label>Observações internas</Label>
        <Textarea placeholder="Notas sobre o produto..." value={form.notes} onChange={e => setField('notes', e.target.value)} className="mt-1" rows={3} />
      </div>

      <div className="flex justify-end gap-3 pb-6">
        <Button variant="outline" onClick={() => navigate(isPresale ? '/produtos/pre-venda' : '/produtos')}>Cancelar</Button>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? 'Salvando...' : isEdit ? 'Salvar alterações' : isPresale ? 'Criar pré-venda' : 'Criar produto'}
        </Button>
      </div>
      </>}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Wand2, ChevronDown, ChevronUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import ImageUpload from '@/components/shared/ImageUpload';
import { PreSaleProduct, PreSaleCampaign, PreSaleSupplier, PreSaleCategory } from '@/api/entities';
import { formatCurrency, cn } from '@/lib/utils';
import { toast } from 'sonner';

// ─── Opções pré-definidas ───────────────────────────────────────────────────
const SIZES_LETTER = ['PP', 'P', 'M', 'G', 'GG', 'XG', '2XG', '3XG'];
const SIZES_NUMERIC = ['34', '36', '38', '40', '42', '44', '46', '48'];
const GENDERS = ['Masculino', 'Feminino', 'Unissex'];

const EMPTY = {
  name: '', supplier: '', sale_price: '', regular_price: '', cost_price: '',
  extra_cost: '', extra_cost_description: '',
  category: '', subcategory: '',
  status: 'active', campaign_id: '', variations: [], notes: '',
};

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

export default function ProductForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState(EMPTY);
  const [campaigns, setCampaigns] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [categories, setCategories] = useState([]);
  const [saving, setSaving] = useState(false);
  const isEdit = Boolean(id);

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
      PreSaleProduct.get(id).then(async p => {
        const images = p.images || (p.image ? [p.image] : []);
        // Se tem supplier_id, usa ele. Se só tem supplier (nome), tenta achar pelo nome
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
          variations: p.variations || [],
          images,
        });
      });
    }
  }, [id]);

  const salePrice = parseFloat(form.sale_price) || 0;
  const regularPrice = parseFloat(form.regular_price) || 0;
  const costPrice = parseFloat(form.cost_price) || 0;
  const extraCost = parseFloat(form.extra_cost) || 0;
  const totalCost = costPrice + extraCost;
  const profit = salePrice - totalCost;
  const margin = salePrice > 0 ? (profit / salePrice) * 100 : 0;
  const discount = regularPrice > salePrice ? Math.round((1 - salePrice / regularPrice) * 100) : 0;

  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }));

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

    if (sizes.length > 0 && genGenders.length > 0) {
      // Combinação tamanho × gênero
      for (const gender of genGenders) {
        for (const size of sizes) {
          const name = `${gender} - ${size}`;
          if (!existing.find(v => v.name === name)) {
            toAdd.push({ name, gender, size, sale_price: '', regular_price: '', cost_price: '' });
          }
        }
      }
    } else if (sizes.length > 0) {
      for (const size of sizes) {
        if (!existing.find(v => v.size === size && !v.gender)) {
          toAdd.push({ name: size, size, gender: '', sale_price: '', regular_price: '', cost_price: '' });
        }
      }
    } else {
      for (const gender of genGenders) {
        if (!existing.find(v => v.gender === gender && !v.size)) {
          toAdd.push({ name: gender, gender, size: '', sale_price: '', regular_price: '', cost_price: '' });
        }
      }
    }

    if (toAdd.length === 0) return toast.info('Essas variações já existem');
    setForm(f => ({ ...f, variations: [...(f.variations || []), ...toAdd] }));
    toast.success(`${toAdd.length} variações adicionadas!`);
    setGenSizes([]);
    setGenGenders([]);
    setShowGenerator(false);
  };

  const toggleSize = (s) => setGenSizes(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);
  const toggleGender = (g) => setGenGenders(prev => prev.includes(g) ? prev.filter(x => x !== g) : [...prev, g]);

  const addVariation = () => setForm(f => ({
    ...f,
    variations: [...(f.variations || []), { name: '', gender: '', size: '', sale_price: '', regular_price: '', cost_price: '' }],
  }));

  const updateVariation = (i, k, v) => setForm(f => {
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
    return { ...f, variations: vars };
  });

  const removeVariation = (i) => setForm(f => ({ ...f, variations: f.variations.filter((_, idx) => idx !== i) }));

  const handleSave = async () => {
    if (!form.name.trim()) return toast.error('Nome é obrigatório');
    if (!form.sale_price) return toast.error('Preço de venda é obrigatório');
    setSaving(true);
    try {
      const payload = {
        ...form,
        sale_price: salePrice,
        regular_price: regularPrice || null,
        cost_price: costPrice,
        extra_cost: extraCost,
        total_cost: totalCost,
        profit_per_unit: profit,
        margin_percent: margin,
        discount_percent: discount || null,
        variations: (form.variations || []).map(v => ({
          ...v,
          sale_price: parseFloat(v.sale_price) || null,
          regular_price: parseFloat(v.regular_price) || null,
          cost_price: parseFloat(v.cost_price) || null,
        })),
      };
      if (isEdit) {
        await PreSaleProduct.update(id, payload);
        toast.success('Produto atualizado!');
      } else {
        await PreSaleProduct.create(payload);
        toast.success('Produto criado!');
      }
      navigate('/produtos');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const variations = form.variations || [];

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <h2 className="text-xl font-bold">{isEdit ? 'Editar Produto' : 'Novo Produto'}</h2>
      </div>

      {/* Informações básicas */}
      <Card>
        <CardHeader><CardTitle>Informações básicas</CardTitle></CardHeader>
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
          <div>
            <Label>Nome do produto *</Label>
            <Input placeholder="Ex: Camiseta EON Dri-Fit" value={form.name} onChange={e => setField('name', e.target.value)} className="mt-1" />
          </div>
          <div className="grid grid-cols-2 gap-4">
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
          <div className="grid grid-cols-2 gap-4">
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
            <div>
              <Label>Campanha (opcional)</Label>
              <Select value={form.campaign_id || '_none'} onValueChange={v => setField('campaign_id', v === '_none' ? '' : v)}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Selecionar..." /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">Sem campanha</SelectItem>
                  {campaigns.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label>Status</Label>
            <Select value={form.status} onValueChange={v => setField('status', v)}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Ativo</SelectItem>
                <SelectItem value="inactive">Inativo</SelectItem>
                <SelectItem value="pre_sale_closed">Pré-venda encerrada</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Preços e custos */}
      <Card>
        <CardHeader><CardTitle>Preços e custos padrão</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Preço pré-venda (R$) *</Label>
              <Input type="number" step="0.01" min="0" placeholder="0,00" value={form.sale_price} onChange={e => setField('sale_price', e.target.value)} className="mt-1" />
              <p className="text-xs text-muted-foreground mt-1">O que o cliente paga na pré-venda</p>
            </div>
            <div>
              <Label>Preço regular em estoque (R$)</Label>
              <Input type="number" step="0.01" min="0" placeholder="0,00" value={form.regular_price} onChange={e => setField('regular_price', e.target.value)} className="mt-1" />
              <p className="text-xs text-muted-foreground mt-1">Preço cheio quando disponível normalmente</p>
            </div>
          </div>

          {discount > 0 && (
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
              <Input placeholder="Ex: frete, embalagem, taxa" value={form.extra_cost_description} onChange={e => setField('extra_cost_description', e.target.value)} className="mt-1" />
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
              <div className="grid grid-cols-[1fr,100px,100px,90px,90px,90px,36px] gap-2 text-xs font-medium text-muted-foreground px-1">
                <span>Nome / Variação</span>
                <span>Gênero</span>
                <span>Tamanho</span>
                <span className="text-right">Pré-venda</span>
                <span className="text-right">Regular</span>
                <span className="text-right">Custo</span>
                <span />
              </div>

              {variations.map((v, i) => (
                <div key={i} className="grid grid-cols-[1fr,100px,100px,90px,90px,90px,36px] gap-2 items-center p-2 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-200">
                  <Input
                    placeholder="Ex: Fem. - M, Azul GG..."
                    value={v.name}
                    onChange={e => updateVariation(i, 'name', e.target.value)}
                    className="h-8 text-sm"
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
                  <Button size="icon" variant="ghost" onClick={() => removeVariation(i)} className="h-8 w-8 text-red-400 hover:text-red-700">
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}

              <p className="text-xs text-muted-foreground px-1 pt-1">
                {variations.length} variação{variations.length !== 1 ? 'ões' : ''} cadastrada{variations.length !== 1 ? 's' : ''}.
                Preço/custo em branco = usa o padrão do produto.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Observações */}
      <div>
        <Label>Observações internas</Label>
        <Textarea placeholder="Notas sobre o produto..." value={form.notes} onChange={e => setField('notes', e.target.value)} className="mt-1" rows={3} />
      </div>

      <div className="flex justify-end gap-3 pb-6">
        <Button variant="outline" onClick={() => navigate(-1)}>Cancelar</Button>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? 'Salvando...' : isEdit ? 'Salvar alterações' : 'Criar produto'}
        </Button>
      </div>
    </div>
  );
}

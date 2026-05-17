import { useEffect, useState } from 'react';
import { Plus, Tag, Trash2, Edit2, Check, X, ChevronDown, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PreSaleCategory } from '@/api/entities';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

export default function Categories() {
  const [categories, setCategories] = useState([]);
  const [expanded, setExpanded] = useState({});
  const [newCatName, setNewCatName] = useState('');
  const [editingCat, setEditingCat] = useState(null); // { id, name }
  const [newSubName, setNewSubName] = useState({}); // { catId: '' }
  const [editingSub, setEditingSub] = useState(null); // { catId, index, name }

  const load = () => PreSaleCategory.list().then(setCategories);
  useEffect(() => { load(); }, []);

  // ─── Categorias ──────────────────────────────────────────────────────────────

  const addCategory = async () => {
    const name = newCatName.trim();
    if (!name) return;
    if (categories.find(c => c.name.toLowerCase() === name.toLowerCase()))
      return toast.error('Categoria já existe');
    await PreSaleCategory.create({ name, subcategories: [] });
    setNewCatName('');
    load();
  };

  const saveCategory = async (cat) => {
    const name = editingCat.name.trim();
    if (!name) return;
    await PreSaleCategory.update(cat.id, { name });
    setEditingCat(null);
    load();
  };

  const deleteCategory = async (cat) => {
    if (!confirm(`Excluir categoria "${cat.name}" e todas suas subcategorias?`)) return;
    await PreSaleCategory.delete(cat.id);
    toast.success('Categoria excluída');
    load();
  };

  // ─── Subcategorias ───────────────────────────────────────────────────────────

  const addSub = async (cat) => {
    const name = (newSubName[cat.id] || '').trim();
    if (!name) return;
    const subs = cat.subcategories || [];
    if (subs.includes(name)) return toast.error('Subcategoria já existe');
    await PreSaleCategory.update(cat.id, { subcategories: [...subs, name] });
    setNewSubName(prev => ({ ...prev, [cat.id]: '' }));
    load();
  };

  const saveSub = async (cat) => {
    const name = editingSub.name.trim();
    if (!name) return;
    const subs = [...(cat.subcategories || [])];
    subs[editingSub.index] = name;
    await PreSaleCategory.update(cat.id, { subcategories: subs });
    setEditingSub(null);
    load();
  };

  const deleteSub = async (cat, idx) => {
    const subs = (cat.subcategories || []).filter((_, i) => i !== idx);
    await PreSaleCategory.update(cat.id, { subcategories: subs });
    load();
  };

  const toggleExpand = (id) => setExpanded(prev => ({ ...prev, [id]: !prev[id] }));

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Categorias</h2>
        <p className="text-sm text-muted-foreground">Organize seus produtos por categoria e subcategoria</p>
      </div>

      {/* Adicionar nova categoria */}
      <div className="flex gap-2">
        <Input
          placeholder="Nova categoria (ex: Camisetas, Calções...)"
          value={newCatName}
          onChange={e => setNewCatName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addCategory()}
          className="flex-1"
        />
        <Button onClick={addCategory} disabled={!newCatName.trim()}>
          <Plus className="w-4 h-4" /> Adicionar
        </Button>
      </div>

      {categories.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16 text-center">
            <Tag className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">Nenhuma categoria cadastrada</p>
            <p className="text-xs text-muted-foreground mt-1">Crie categorias para organizar seus produtos</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {categories.map(cat => {
            const subs = cat.subcategories || [];
            const isExpanded = expanded[cat.id];
            const isEditingThis = editingCat?.id === cat.id;

            return (
              <Card key={cat.id} className="overflow-hidden">
                {/* Cabeçalho da categoria */}
                <div className="flex items-center gap-2 px-4 py-3 bg-gray-50 border-b">
                  <button onClick={() => toggleExpand(cat.id)} className="text-gray-400 hover:text-gray-600">
                    {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </button>

                  <Tag className="w-4 h-4 text-blue-500 shrink-0" />

                  {isEditingThis ? (
                    <Input
                      value={editingCat.name}
                      onChange={e => setEditingCat(prev => ({ ...prev, name: e.target.value }))}
                      onKeyDown={e => { if (e.key === 'Enter') saveCategory(cat); if (e.key === 'Escape') setEditingCat(null); }}
                      className="h-7 text-sm flex-1"
                      autoFocus
                    />
                  ) : (
                    <button onClick={() => toggleExpand(cat.id)} className="flex-1 text-left font-semibold text-gray-900 text-sm">
                      {cat.name}
                      <span className="ml-2 text-xs font-normal text-muted-foreground">{subs.length} subcategoria{subs.length !== 1 ? 's' : ''}</span>
                    </button>
                  )}

                  <div className="flex gap-1 shrink-0">
                    {isEditingThis ? (
                      <>
                        <button onClick={() => saveCategory(cat)} className="w-7 h-7 rounded flex items-center justify-center text-green-600 hover:bg-green-50">
                          <Check className="w-4 h-4" />
                        </button>
                        <button onClick={() => setEditingCat(null)} className="w-7 h-7 rounded flex items-center justify-center text-gray-400 hover:bg-gray-100">
                          <X className="w-4 h-4" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => { setEditingCat({ id: cat.id, name: cat.name }); setExpanded(p => ({ ...p, [cat.id]: true })); }}
                          className="w-7 h-7 rounded flex items-center justify-center text-gray-400 hover:bg-gray-100 hover:text-gray-600">
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => deleteCategory(cat)}
                          className="w-7 h-7 rounded flex items-center justify-center text-gray-400 hover:bg-red-50 hover:text-red-500">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Subcategorias (expansível) */}
                {isExpanded && (
                  <CardContent className="p-3 space-y-1">
                    {subs.map((sub, idx) => {
                      const isEditingSub = editingSub?.catId === cat.id && editingSub?.index === idx;
                      return (
                        <div key={idx} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 group">
                          <span className="w-1.5 h-1.5 rounded-full bg-gray-300 shrink-0 ml-1" />
                          {isEditingSub ? (
                            <Input
                              value={editingSub.name}
                              onChange={e => setEditingSub(p => ({ ...p, name: e.target.value }))}
                              onKeyDown={e => { if (e.key === 'Enter') saveSub(cat); if (e.key === 'Escape') setEditingSub(null); }}
                              className="h-7 text-sm flex-1"
                              autoFocus
                            />
                          ) : (
                            <span className="flex-1 text-sm text-gray-700">{sub}</span>
                          )}
                          <div className={cn('flex gap-1 shrink-0', isEditingSub ? 'visible' : 'invisible group-hover:visible')}>
                            {isEditingSub ? (
                              <>
                                <button onClick={() => saveSub(cat)} className="w-6 h-6 rounded flex items-center justify-center text-green-600 hover:bg-green-50">
                                  <Check className="w-3.5 h-3.5" />
                                </button>
                                <button onClick={() => setEditingSub(null)} className="w-6 h-6 rounded flex items-center justify-center text-gray-400 hover:bg-gray-100">
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </>
                            ) : (
                              <>
                                <button onClick={() => setEditingSub({ catId: cat.id, index: idx, name: sub })}
                                  className="w-6 h-6 rounded flex items-center justify-center text-gray-400 hover:bg-gray-100 hover:text-gray-600">
                                  <Edit2 className="w-3 h-3" />
                                </button>
                                <button onClick={() => deleteSub(cat, idx)}
                                  className="w-6 h-6 rounded flex items-center justify-center text-gray-400 hover:bg-red-50 hover:text-red-500">
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}

                    {/* Adicionar subcategoria */}
                    <div className="flex gap-2 pt-1">
                      <Input
                        placeholder="Nova subcategoria..."
                        value={newSubName[cat.id] || ''}
                        onChange={e => setNewSubName(p => ({ ...p, [cat.id]: e.target.value }))}
                        onKeyDown={e => e.key === 'Enter' && addSub(cat)}
                        className="h-8 text-sm flex-1"
                      />
                      <Button size="sm" variant="outline" onClick={() => addSub(cat)} disabled={!(newSubName[cat.id] || '').trim()}>
                        <Plus className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

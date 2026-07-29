import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  HandCoins, Clock, CheckCircle2, Paperclip, Download, Trash2, Upload, Search,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  listRefunds, uploadRefundReceipt, getRefundReceiptUrl, deleteRefundReceipt,
  completeAssessmentContractRefund,
} from '@/api/client';
import { formatCurrency, formatDate, todayLocalStr } from '@/lib/utils';
import { usePageData } from '@/hooks/usePageData';
import { invalidatePageCacheByTag } from '@/lib/page-cache';
import { toast } from 'sonner';

const TABS = [
  { key: 'pending', label: 'A fazer',  icon: Clock },
  { key: 'done',    label: 'Feitos',   icon: CheckCircle2 },
  { key: 'all',     label: 'Todos',    icon: HandCoins },
];

const SOURCE_LABEL = {
  assessment_contract: 'Contrato',
  presale_order: 'Pré-venda',
  stock_order: 'Estoque',
};

const SOURCE_LINK = {
  assessment_contract: id => `/assessoria/contratos/${id}`,
  presale_order: id => `/pedidos/${id}`,
  stock_order: id => `/estoque/pedidos/${id}`,
};

async function loadRefundsPage() {
  return listRefunds();
}

export default function Refunds() {
  const { data: refunds, loading, refresh } = usePageData({
    key: 'refunds:list',
    loader: loadRefundsPage,
    initialData: [],
    tags: ['assessment_contracts', 'refund_receipts'],
    onError: () => toast.error('Erro ao carregar estornos'),
  });

  const [tab, setTab] = useState('pending');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [doneModal, setDoneModal] = useState(null);
  const [doneForm, setDoneForm] = useState({ date: todayLocalStr(), notes: '' });
  const [saving, setSaving] = useState(false);
  const [busyReceipt, setBusyReceipt] = useState(null);
  const fileInputs = useRef({});

  const filtered = useMemo(() => (refunds || []).filter(r => {
    if (tab !== 'all' && r.status !== tab) return false;
    const day = r.status === 'done' ? r.completed_on : r.requested_on;
    if (from && day && day < from) return false;
    if (to && day && day > to) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return r.customer_name?.toLowerCase().includes(q) ||
           r.reference?.toLowerCase().includes(q) ||
           r.reason?.toLowerCase().includes(q);
  }), [refunds, tab, search, from, to]);

  const totals = useMemo(() => {
    const all = refunds || [];
    return {
      pending: all.filter(r => r.status === 'pending').length,
      done: all.filter(r => r.status === 'done').length,
      all: all.length,
      pendingValue: all.filter(r => r.status === 'pending')
        .reduce((s, r) => s + Number(r.amount || 0), 0),
      shownValue: filtered.reduce((s, r) => s + Number(r.amount || 0), 0),
    };
  }, [refunds, filtered]);

  const markDone = async () => {
    if (!doneForm.date) return toast.error('Informe a data do estorno');
    setSaving(true);
    try {
      await completeAssessmentContractRefund(doneModal.source_id, {
        refundDate: doneForm.date,
        refundNotes: doneForm.notes || null,
        expectedUpdatedAt: doneModal.updated_at,
      });
      toast.success('Estorno marcado como realizado.');
      setDoneModal(null);
      setDoneForm({ date: todayLocalStr(), notes: '' });
      invalidatePageCacheByTag('assessment_contracts');
      await refresh({ force: true });
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  const pickFile = (row) => fileInputs.current[`${row.source_type}:${row.source_id}`]?.click();

  const onFile = async (row, event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const key = `${row.source_type}:${row.source_id}`;
    setBusyReceipt(key);
    try {
      await uploadRefundReceipt(row.source_type, row.source_id, file);
      toast.success('Comprovante anexado.');
      invalidatePageCacheByTag('refund_receipts');
      await refresh({ force: true });
    } catch (e) { toast.error(e.message); }
    finally { setBusyReceipt(null); }
  };

  const openReceipt = async (receipt) => {
    setBusyReceipt(receipt.id);
    try {
      const { url } = await getRefundReceiptUrl(receipt.id);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) { toast.error(e.message); }
    finally { setBusyReceipt(null); }
  };

  const removeReceipt = async (receipt) => {
    if (!confirm(`Remover o comprovante "${receipt.file_name}"?`)) return;
    setBusyReceipt(receipt.id);
    try {
      await deleteRefundReceipt(receipt.id);
      toast.success('Comprovante removido.');
      invalidatePageCacheByTag('refund_receipts');
      await refresh({ force: true });
    } catch (e) { toast.error(e.message); }
    finally { setBusyReceipt(null); }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <HandCoins className="w-5 h-5 text-purple-600" /> Central de Estornos
          </h2>
          <p className="text-sm text-muted-foreground">
            {totals.pending > 0
              ? `${totals.pending} a fazer · ${formatCurrency(totals.pendingValue)} em aberto`
              : 'Nenhum estorno pendente'}
          </p>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`text-xs font-medium px-3 py-2 rounded-lg border flex items-center gap-1.5 ${
              tab === t.key
                ? 'bg-purple-50 border-purple-300 text-purple-700'
                : 'border-gray-200 text-gray-600'
            }`}
          >
            <t.icon className="w-3.5 h-3.5" />
            {t.label} <span className="font-bold">{totals[t.key]}</span>
          </button>
        ))}
      </div>

      <div className="flex gap-2 flex-wrap items-end">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por cliente, número ou motivo..."
            className="pl-9"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div>
          <Label className="text-xs">De</Label>
          <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="mt-1" />
        </div>
        <div>
          <Label className="text-xs">Até</Label>
          <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="mt-1" />
        </div>
        {(from || to || search) && (
          <Button variant="outline" onClick={() => { setFrom(''); setTo(''); setSearch(''); }}>
            Limpar
          </Button>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground text-center py-8">Carregando...</p>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {tab === 'pending'
              ? 'Nenhum estorno a fazer. Quando um contrato pago for cancelado, ele aparece aqui.'
              : 'Nenhum estorno neste filtro.'}
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {filtered.length} estorno{filtered.length !== 1 ? 's' : ''} · total {formatCurrency(totals.shownValue)}
          </p>
          <div className="space-y-3">
            {filtered.map(row => {
              const key = `${row.source_type}:${row.source_id}`;
              const link = SOURCE_LINK[row.source_type]?.(row.source_id);
              return (
                <Card key={key}>
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                            {SOURCE_LABEL[row.source_type]}
                          </span>
                          {link ? (
                            <Link to={link} className="font-mono text-sm font-semibold text-blue-600 hover:underline">
                              {row.reference}
                            </Link>
                          ) : (
                            <span className="font-mono text-sm font-semibold">{row.reference}</span>
                          )}
                          {row.kind === 'automatic' && (
                            <span className="text-xs text-blue-700">via Asaas (automático)</span>
                          )}
                        </div>
                        <p className="text-sm font-medium mt-1">{row.customer_name || '—'}</p>
                        {row.reason && (
                          <p className="text-xs text-muted-foreground mt-0.5">{row.reason}</p>
                        )}
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-bold text-green-700">{formatCurrency(row.amount)}</p>
                        <p className="text-xs text-muted-foreground">
                          {row.status === 'done'
                            ? `Estornado em ${formatDate(row.completed_on)}`
                            : `Pedido em ${formatDate(row.requested_on)}`}
                        </p>
                      </div>
                    </div>

                    {row.notes && (
                      <p className="text-xs bg-gray-50 border rounded-lg px-3 py-2">{row.notes}</p>
                    )}

                    <div className="flex items-center justify-between gap-2 flex-wrap border-t pt-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        {(row.receipts || []).length === 0 ? (
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Paperclip className="w-3 h-3" /> Sem comprovante
                          </span>
                        ) : (
                          (row.receipts || []).map(rec => (
                            <span key={rec.id} className="text-xs flex items-center gap-1 bg-purple-50 border border-purple-200 rounded-full pl-2 pr-1 py-0.5">
                              <Paperclip className="w-3 h-3 text-purple-600" />
                              <button
                                onClick={() => openReceipt(rec)}
                                disabled={busyReceipt === rec.id}
                                className="text-purple-800 hover:underline disabled:opacity-50 max-w-[180px] truncate"
                                title={rec.file_name}
                              >
                                {rec.file_name}
                              </button>
                              <button
                                onClick={() => openReceipt(rec)}
                                disabled={busyReceipt === rec.id}
                                className="p-0.5 text-purple-600 hover:text-purple-900 disabled:opacity-50"
                                title="Baixar"
                              >
                                <Download className="w-3 h-3" />
                              </button>
                              <button
                                onClick={() => removeReceipt(rec)}
                                disabled={busyReceipt === rec.id}
                                className="p-0.5 text-red-500 hover:text-red-700 disabled:opacity-50"
                                title="Remover"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </span>
                          ))
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp,application/pdf"
                          className="hidden"
                          ref={el => { fileInputs.current[key] = el; }}
                          onChange={e => onFile(row, e)}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => pickFile(row)}
                          disabled={busyReceipt === key}
                        >
                          <Upload className="w-3.5 h-3.5 mr-1" />
                          {busyReceipt === key ? 'Enviando...' : 'Anexar comprovante'}
                        </Button>
                        {row.status === 'pending' && row.kind === 'manual' && (
                          <Button
                            size="sm"
                            className="bg-green-600 hover:bg-green-700 text-white"
                            onClick={() => { setDoneModal(row); setDoneForm({ date: todayLocalStr(), notes: '' }); }}
                          >
                            Marcar como feito
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </>
      )}

      <Dialog open={!!doneModal} onOpenChange={open => !open && !saving && setDoneModal(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-green-700">
              <CheckCircle2 className="w-5 h-5" /> Confirmar estorno
            </DialogTitle>
          </DialogHeader>
          {doneModal && (
            <div className="space-y-3">
              <div className="bg-gray-50 border rounded-xl p-3 text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Contrato</span>
                  <span className="font-mono font-semibold">{doneModal.reference}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Cliente</span>
                  <span className="font-medium">{doneModal.customer_name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Valor</span>
                  <span className="font-bold text-green-700">{formatCurrency(doneModal.amount)}</span>
                </div>
              </div>
              <div>
                <Label>Data do estorno</Label>
                <Input
                  type="date"
                  className="mt-1"
                  max={todayLocalStr()}
                  value={doneForm.date}
                  onChange={e => setDoneForm(f => ({ ...f, date: e.target.value }))}
                />
              </div>
              <div>
                <Label>Observação</Label>
                <Textarea
                  rows={2}
                  className="mt-1"
                  placeholder="Ex.: PIX devolvido, comprovante anexado"
                  value={doneForm.notes}
                  onChange={e => setDoneForm(f => ({ ...f, notes: e.target.value }))}
                />
              </div>
              {(doneModal.receipts || []).length === 0 && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  Este estorno ainda não tem comprovante anexado. Dá para marcar como feito assim mesmo e anexar depois.
                </p>
              )}
              <div className="flex gap-2 pt-1">
                <Button variant="outline" className="flex-1" onClick={() => setDoneModal(null)} disabled={saving}>
                  Voltar
                </Button>
                <Button
                  className="flex-1 bg-green-600 hover:bg-green-700 text-white"
                  onClick={markDone}
                  disabled={saving}
                >
                  {saving ? 'Salvando...' : 'Confirmar'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { importContractParcels, previewContractParcels } from '@/api/client';
import { formatBrl, isPaidInAsaas } from '@/lib/contract-parcels';
import { formatDate } from '@/lib/utils';

const CHECK_LABELS = {
  match: 'CPF da fatura confere com o cadastro',
  match_cnpj: 'CNPJ da fatura confere com o cadastro',
  mismatch: 'O documento da fatura no Asaas não é desta pessoa',
  unknown: 'Não foi possível conferir o documento no Asaas',
};

// Lê no Asaas o parcelamento (boleto/PIX parcelado) a partir do link de qualquer
// parcela, mostra as parcelas e só grava no contrato depois da confirmação. O
// Asaas só é consultado; nada é criado ou alterado lá.
export default function ImportParcelsDialog({ open, contract, onClose, onImported }) {
  const [link, setLink] = useState('');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (open) {
      setLink(contract?.external_payment_link || '');
      setPreview(null);
      setError('');
    }
  }, [open, contract?.id, contract?.external_payment_link]);

  async function readParcels() {
    setReading(true);
    setError('');
    setPreview(null);
    try {
      setPreview(await previewContractParcels(contract.id, { link: link.trim() || undefined }));
    } catch (e) {
      setError(e.message || 'Não foi possível ler as parcelas no Asaas');
    } finally {
      setReading(false);
    }
  }

  async function confirmImport() {
    setImporting(true);
    try {
      await importContractParcels(contract.id, {
        link: link.trim() || undefined,
        expectedUpdatedAt: contract.updated_at,
      });
      toast.success(`${preview.parcels.length} parcelas importadas. Cada uma tem o seu link.`);
      onImported?.();
      onClose();
    } catch (e) {
      setError(e.message || 'Não foi possível importar as parcelas');
    } finally {
      setImporting(false);
    }
  }

  const blocked = !preview || preview.already_imported || preview.blockers.length > 0;

  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !importing) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Importar parcelas do Asaas (carnê)</DialogTitle>
          <DialogDescription>
            Use quando a pessoa escolheu boleto/PIX parcelado. O sistema só lê o Asaas e guarda cada parcela com o seu link.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="parcels-link">Link de uma das parcelas</Label>
            <div className="flex gap-2 mt-1">
              <Input
                id="parcels-link"
                value={link}
                placeholder="https://www.asaas.com/i/..."
                disabled={reading || importing}
                onChange={event => { setLink(event.target.value); setPreview(null); setError(''); }}
              />
              <Button variant="outline" onClick={readParcels} disabled={reading || importing || !link.trim()}>
                {reading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Ler parcelas'}
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Pode ser o link já registrado no contrato ou o de qualquer outra parcela do mesmo parcelamento.
            </p>
          </div>

          {error && (
            <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
          )}

          {preview && (
            <div className="space-y-2">
              <div className="border rounded-xl overflow-hidden">
                <div className="bg-blue-50 border-b border-blue-200 px-3 py-2 text-xs font-semibold text-blue-900">
                  {preview.parcels.length} parcelas · {formatBrl(preview.total_value)}
                  {preview.contract_total != null && ` (contrato: ${formatBrl(preview.contract_total)})`}
                </div>
                <div className="divide-y">
                  {preview.parcels.map(parcel => (
                    <div key={parcel.asaas_payment_id} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <span className="text-xs font-bold text-muted-foreground w-10 shrink-0">
                        {parcel.installment_number}/{preview.parcels.length}
                      </span>
                      <span className="flex-1 text-xs text-gray-700">vence {formatDate(parcel.due_date)}</span>
                      {isPaidInAsaas(parcel) && <Badge variant="info">Paga no Asaas</Badge>}
                      <span className="font-semibold text-sm">{formatBrl(parcel.value)}</span>
                    </div>
                  ))}
                </div>
              </div>

              <p className={`flex items-center gap-1.5 text-xs ${['match', 'match_cnpj'].includes(preview.customer_check) ? 'text-green-700' : 'text-red-700'}`}>
                {['match', 'match_cnpj'].includes(preview.customer_check)
                  ? <CheckCircle2 className="w-3.5 h-3.5" />
                  : <AlertTriangle className="w-3.5 h-3.5" />}
                {CHECK_LABELS[preview.customer_check]}
              </p>
              {preview.already_imported && (
                <p className="text-xs text-amber-700">Este contrato já tem as parcelas importadas. Use "Atualizar parcelas" no card.</p>
              )}
              {preview.blockers.map(blocker => (
                <p key={blocker} role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{blocker}</p>
              ))}
              <p className="text-[11px] text-muted-foreground">
                Importar não marca nada como pago. O pagamento de cada parcela é registrado depois, no card de parcelas.
              </p>
            </div>
          )}

          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" disabled={importing} onClick={onClose}>Cancelar</Button>
            <Button className="flex-1" disabled={blocked || importing} onClick={confirmImport}>
              {importing ? 'Importando…' : `Importar ${preview ? preview.parcels.length : ''} parcelas`.replace('  ', ' ')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

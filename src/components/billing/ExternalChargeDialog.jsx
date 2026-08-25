import { Link2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import ExternalChargeForm from '@/components/billing/ExternalChargeForm';

export default function ExternalChargeDialog({
  open,
  onCancel,
  hasCharge,
  form,
  setForm,
  saving,
  onSave,
  preventOutsideClose = false,
}) {
  const close = () => {
    if (!saving) onCancel();
  };

  return (
    <Dialog open={open} onOpenChange={nextOpen => !nextOpen && close()}>
      <DialogContent
        className="max-w-md"
        onInteractOutside={preventOutsideClose ? event => event.preventDefault() : undefined}
        onFocusOutside={preventOutsideClose ? event => event.preventDefault() : undefined}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="w-5 h-5 text-amber-600" />
            {hasCharge ? 'Editar cobrança externa' : 'Cadastrar cobrança externa'}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Informe os dados da cobrança criada fora da plataforma.
          </DialogDescription>
        </DialogHeader>
        <ExternalChargeForm
          form={form}
          setForm={setForm}
          saving={saving}
          onSave={onSave}
          onCancel={close}
        />
      </DialogContent>
    </Dialog>
  );
}

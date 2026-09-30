import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

// Confirmação no visual do sistema, no lugar do confirm() do navegador.
export default function ConfirmDialog({
  open,
  onOpenChange,
  title,
  icon: Icon,
  iconClassName,
  children,
  confirmLabel,
  confirmClassName,
  busy = false,
  busyLabel = 'Salvando...',
  cancelLabel = 'Voltar',
  onConfirm,
}) {
  return (
    <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {Icon && <Icon className={cn('w-5 h-5', iconClassName)} />}
            {title}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm text-gray-700">{children}</div>
        <div className="flex gap-2 pt-2">
          <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button className={cn('flex-1', confirmClassName)} onClick={onConfirm} disabled={busy}>
            {busy ? busyLabel : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

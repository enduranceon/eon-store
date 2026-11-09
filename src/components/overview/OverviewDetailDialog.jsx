import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const PAGE_SIZE = 50;

// Lista que compõe um número da Visão geral. Só leitura: ações de cobrança,
// pagamento e estorno ficam nas telas de destino (links da coluna "Abrir").
// columns: [{ key, label, align?, render?(row) }]; rows: itens já filtrados.
// summary: texto curto com a soma e a unidade, para bater com o cartão.
export default function OverviewDetailDialog({
  open, onClose, title, description, summary, columns, rows, emptyText = 'Nada a mostrar.', destination,
}) {
  const [visible, setVisible] = useState(PAGE_SIZE);
  useEffect(() => { if (open) setVisible(PAGE_SIZE); }, [open, title]);
  const shown = rows.slice(0, visible);

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {summary && <p className="text-sm font-medium text-slate-800">{summary}</p>}
        {rows.length === 0 ? (
          <p className="rounded-lg border bg-slate-50 p-4 text-sm text-slate-600">{emptyText}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[32rem] text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-600">
                <tr>
                  {columns.map(column => (
                    <th key={column.key} scope="col" className={`px-3 py-2 font-semibold ${column.align === 'right' ? 'text-right' : ''}`}>{column.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {shown.map((row, index) => (
                  <tr key={row.key ?? row.id ?? index}>
                    {columns.map(column => (
                      <td key={column.key} className={`px-3 py-2 ${column.align === 'right' ? 'text-right tabular-nums' : ''}`}>
                        {column.render ? column.render(row) : row[column.key]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-slate-500">
            {rows.length > 0 && `Mostrando ${shown.length} de ${rows.length}`}
          </p>
          <div className="flex gap-2">
            {rows.length > visible && (
              <Button variant="outline" size="sm" onClick={() => setVisible(count => count + PAGE_SIZE)}>Mostrar mais</Button>
            )}
            {destination && (
              <Button asChild size="sm"><Link to={destination.to} onClick={onClose}>{destination.label}</Link></Button>
            )}
            <Button variant="outline" size="sm" onClick={onClose}>Fechar</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

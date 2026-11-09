import { Label } from '@/components/ui/label';
import { selectableCoaches } from '@/lib/event-whatsapp-group';

// Campos de operação do evento, usados ao criar e ao editar: coaches responsáveis
// (podem ser vários) e se o evento tem grupo no WhatsApp. O coach só enxergará os
// eventos em que é responsável.
export default function EventOperationFields({ coaches, assignedIds = [], form, setForm }) {
  const options = selectableCoaches(coaches, assignedIds);
  const selected = new Set(form.coach_ids || []);

  function toggleCoach(id) {
    setForm(current => {
      const ids = new Set(current.coach_ids || []);
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      return { ...current, coach_ids: [...ids] };
    });
  }

  return (
    <div className="space-y-3 rounded-lg border bg-slate-50 p-3">
      <fieldset>
        <legend className="text-sm font-medium">Coaches responsáveis</legend>
        <p className="text-xs text-muted-foreground">
          Podem ser vários. Quando o login do coach existir, cada coach verá só os eventos em que é responsável.
        </p>
        {options.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">Nenhum coach ativo cadastrado.</p>
        ) : (
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {options.map(coach => (
              <label key={coach.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-gray-300"
                  checked={selected.has(coach.id)}
                  onChange={() => toggleCoach(coach.id)}
                />
                <span>{coach.name}{coach.active === false ? ' (inativo)' : ''}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <div>
        <label className="flex items-center gap-2 text-sm font-medium" htmlFor="event-whatsapp-group">
          <input
            id="event-whatsapp-group"
            type="checkbox"
            className="h-4 w-4 rounded border-gray-300"
            checked={Boolean(form.whatsapp_group_enabled)}
            onChange={event => setForm(current => ({ ...current, whatsapp_group_enabled: event.target.checked }))}
          />
          <Label htmlFor="event-whatsapp-group" className="cursor-pointer text-sm font-medium">Este evento tem grupo no WhatsApp</Label>
        </label>
        <p className="mt-1 pl-6 text-xs text-muted-foreground">
          Depois que a pessoa paga, a inscrição passa a mostrar se ela já está no grupo, para você acompanhar quem falta adicionar.
        </p>
      </div>
    </div>
  );
}

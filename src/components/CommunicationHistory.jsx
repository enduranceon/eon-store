import { useState } from 'react';
import { ChevronDown, ChevronUp, MessageCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/lib/utils';
import { COMMUNICATION_EVENT_META, summarizeCommunicationEvent } from '@/lib/communication-tasks';

function HistoryItem({ event, currentUserId }) {
  const [open, setOpen] = useState(false);
  const meta = COMMUNICATION_EVENT_META[event.event_type] || { label: event.event_type, tone: 'secondary' };
  const summary = summarizeCommunicationEvent(event);
  const message = event.payload?.message || '';
  const sentByMe = currentUserId && event.created_by === currentUserId;

  return (
    <li className="py-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant={meta.tone}>{meta.label}</Badge>
          {summary && <span className="text-xs text-muted-foreground">{summary}</span>}
        </div>
        <span className="text-[11px] text-muted-foreground whitespace-nowrap">{formatDateTime(event.created_at)}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
        {sentByMe && <span>Enviada por você</span>}
        {message && (
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            className="inline-flex items-center gap-1 text-blue-600 hover:underline"
          >
            {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {open ? 'Ocultar mensagem' : 'Ver mensagem'}
          </button>
        )}
      </div>
      {open && message && (
        <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg border bg-gray-50 p-3 font-sans text-xs text-gray-700 leading-relaxed">
          {message}
        </pre>
      )}
    </li>
  );
}

export default function CommunicationHistory({ events = [], currentUserId = null }) {
  if (!events.length) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        <MessageCircle className="w-6 h-6 mx-auto mb-2 text-gray-300" />
        Nenhuma mensagem enviada ainda.
      </div>
    );
  }
  return (
    <ul className="divide-y">
      {events.map(event => (
        <HistoryItem key={event.id} event={event} currentUserId={currentUserId} />
      ))}
    </ul>
  );
}

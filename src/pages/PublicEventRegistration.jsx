import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CalendarDays, CheckCircle2, Clock, ExternalLink, MapPin, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { createPublicEventRegistration, getPublicEvent } from '@/api/public';
import { formatCurrency, formatDate } from '@/lib/utils';
import { toast } from 'sonner';

function normalizeFieldToken(value = '') {
  return value
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function fieldToken(field) {
  return normalizeFieldToken(`${field.key || ''} ${field.label || ''}`);
}

function fieldMatches(field, aliases) {
  const token = fieldToken(field);
  return aliases.some(alias => token === alias || token.includes(alias));
}

function isNativeEventField(field) {
  return fieldMatches(field, [
    'nome', 'nome_completo', 'full_name', 'name',
    'treinador', 'coach', 'trainer',
  ]);
}

function visibleDynamicFields(fields = []) {
  return fields.filter(field => !isNativeEventField(field));
}

function valueByFieldAlias(fields = [], answers = {}, aliases = []) {
  for (const field of fields) {
    if (!fieldMatches(field, aliases)) continue;
    const value = answers[field.key];
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function answersWithNativeFields(fields = [], answers = {}, { fullName, coachName }) {
  const next = { ...answers };
  for (const field of fields) {
    if (!field.key || !isNativeEventField(field)) continue;
    if (fieldMatches(field, ['treinador', 'coach', 'trainer'])) next[field.key] = coachName;
    else next[field.key] = fullName;
  }
  return next;
}

function timeValue(value) {
  return String(value || '').slice(0, 5);
}

function timeSummary(event) {
  const start = timeValue(event?.start_time);
  const end = timeValue(event?.end_time);
  if (start && end) return `${start} - ${end}`;
  return start || end || '';
}

function dateSummary(event) {
  if (!event?.event_date) return 'Data a definir';
  if (event.end_date && event.end_date !== event.event_date) {
    return `${formatDate(event.event_date)} - ${formatDate(event.end_date)}`;
  }
  return formatDate(event.event_date);
}

// Renderiza apenas os campos extras definidos no tipo de inscrição. Nome e
// treinador são campos nativos do formulário público.
function DynamicFields({ fields, answers, onChange }) {
  const visibleFields = visibleDynamicFields(fields);
  if (!visibleFields.length) return null;
  return (
    <div className="space-y-3">
      {visibleFields.map(field => {
        const value = answers[field.key] ?? '';
        const set = v => onChange({ ...answers, [field.key]: v });
        return (
          <div key={field.key}>
            <Label className="text-sm">
              {field.label}
              {field.required && <span className="text-red-500 ml-0.5">*</span>}
            </Label>
            {field.kind === 'textarea' ? (
              <Textarea className="mt-1" rows={2} value={value} onChange={e => set(e.target.value)} />
            ) : field.kind === 'select' ? (
              <Select value={value || undefined} onValueChange={set}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione..." /></SelectTrigger>
                <SelectContent>
                  {(field.options || []).map(opt => <SelectItem key={opt} value={opt}>{opt}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : field.kind === 'boolean' ? (
              <Select value={value === true ? 'sim' : value === false ? 'nao' : undefined}
                onValueChange={v => set(v === 'sim')}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione..." /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="sim">Sim</SelectItem>
                  <SelectItem value="nao">Não</SelectItem>
                </SelectContent>
              </Select>
            ) : field.kind === 'number' ? (
              <Input className="mt-1" type="number" value={value}
                onChange={e => set(e.target.value === '' ? '' : Number(e.target.value))} />
            ) : (
              <Input className="mt-1" value={value} onChange={e => set(e.target.value)} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function PublicEventRegistration() {
  const { slug } = useParams();
  const [event, setEvent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [typeId, setTypeId] = useState('');
  const [customer, setCustomer] = useState({ full_name: '', coach_id: '' });
  const [answers, setAnswers] = useState({});
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    let alive = true;
    getPublicEvent(slug)
      .then(data => { if (alive) { setEvent(data); if (data?.registration_types?.length === 1) setTypeId(data.registration_types[0].id); } })
      .catch(() => { if (alive) setEvent(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [slug]);

  const selectedType = useMemo(
    () => event?.registration_types?.find(t => t.id === typeId) || null,
    [event, typeId],
  );
  const selectedCoach = useMemo(
    () => event?.coaches?.find(coach => coach.id === customer.coach_id) || null,
    [event, customer.coach_id],
  );

  const submit = async () => {
    if (!typeId) return toast.error('Escolha o tipo de inscrição');
    if (!customer.full_name.trim()) return toast.error('Informe seu nome');
    if (!customer.coach_id) return toast.error('Selecione seu treinador');

    const fields = selectedType?.form_fields || [];
    const formAnswers = answersWithNativeFields(fields, answers, {
      fullName: customer.full_name.trim(),
      coachName: selectedCoach?.name || '',
    });
    const whatsapp = valueByFieldAlias(fields, answers, ['whatsapp', 'whats', 'telefone', 'celular', 'phone']);
    const email = valueByFieldAlias(fields, answers, ['email', 'e_mail', 'mail']);
    const cpf = valueByFieldAlias(fields, answers, ['cpf', 'documento']);

    setSending(true);
    try {
      const result = await createPublicEventRegistration({
        event_slug: slug,
        registration_type_id: typeId,
        customer: {
          full_name: customer.full_name.trim(),
          coach_id: customer.coach_id,
          whatsapp: whatsapp || null,
          email: email || null,
          cpf: cpf || null,
        },
        form_answers: formAnswers,
      });
      setDone(result);
    } catch (e) {
      toast.error(e.message || 'Não foi possível concluir a inscrição');
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return <div className="min-h-screen grid place-items-center text-sm text-muted-foreground">Carregando...</div>;
  }

  if (!event) {
    return (
      <div className="min-h-screen grid place-items-center px-4">
        <Card className="max-w-md w-full"><CardContent className="py-10 text-center space-y-2">
          <p className="font-semibold">Inscrições indisponíveis</p>
          <p className="text-sm text-muted-foreground">
            Este evento não está com inscrições abertas no momento. Se você recebeu este link, fale com a equipe Endurance ON.
          </p>
        </CardContent></Card>
      </div>
    );
  }

  if (done) {
    return (
      <div className="min-h-screen grid place-items-center px-4">
        <Card className="max-w-md w-full"><CardContent className="py-10 text-center space-y-3">
          <CheckCircle2 className="w-12 h-12 text-emerald-600 mx-auto" />
          <p className="text-lg font-bold">Inscrição confirmada!</p>
          <p className="text-sm text-muted-foreground">
            {done.event_name}<br />{done.type_name}
          </p>
          <p className="font-mono text-sm bg-gray-50 rounded-lg py-2">{done.registration_number}</p>
          {Number(done.price) > 0 && (
            <p className="text-sm">
              Valor: <strong>{formatCurrency(Number(done.price))}</strong><br />
              <span className="text-muted-foreground">A equipe entrará em contato pelo WhatsApp para o pagamento.</span>
            </p>
          )}
        </CardContent></Card>
      </div>
    );
  }

  const soldOut = selectedType?.spots_left === 0;
  const eventTime = timeSummary(event);

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-lg mx-auto space-y-4">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">{event.name}</h1>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><CalendarDays className="w-4 h-4" /> {dateSummary(event)}</span>
            {eventTime && <span className="inline-flex items-center gap-1.5"><Clock className="w-4 h-4" /> {eventTime}</span>}
            {event.location && <span className="inline-flex items-center gap-1.5"><MapPin className="w-4 h-4" /> {event.location}</span>}
          </div>
          {event.address && <p className="mt-1 text-xs text-muted-foreground">{event.address}</p>}
          {event.online_url && (
            <a className="mt-2 inline-flex items-center gap-1.5 text-sm text-blue-700 hover:underline"
              href={event.online_url} target="_blank" rel="noreferrer">
              <ExternalLink className="w-4 h-4" /> Link online do evento
            </a>
          )}
          {event.description && <p className="mt-3 text-sm text-gray-700">{event.description}</p>}
          {event.public_notes && <p className="mt-2 text-sm text-gray-700 whitespace-pre-wrap">{event.public_notes}</p>}
        </div>

        <Card><CardContent className="p-5 space-y-4">
          <div>
            <Label className="text-sm font-semibold">Escolha sua inscrição</Label>
            <div className="mt-2 space-y-2">
              {event.registration_types.map(t => {
                const out = t.spots_left === 0;
                return (
                  <button key={t.id} type="button" disabled={out}
                    onClick={() => { setTypeId(t.id); setAnswers({}); }}
                    className={`w-full text-left px-4 py-3 rounded-xl border transition-all ${
                      typeId === t.id ? 'border-blue-500 bg-blue-50'
                      : out ? 'border-gray-200 bg-gray-50 opacity-60 cursor-not-allowed'
                      : 'border-gray-200 hover:border-gray-300'
                    }`}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-sm">{t.name}</span>
                      <span className="font-semibold text-sm">{Number(t.price) > 0 ? formatCurrency(Number(t.price)) : 'Gratuito'}</span>
                    </div>
                    {t.spots_left != null && (
                      <span className={`mt-1 inline-flex items-center gap-1 text-xs ${out ? 'text-red-600' : 'text-muted-foreground'}`}>
                        <Users className="w-3 h-3" />
                        {out ? 'Vagas esgotadas' : `${t.spots_left} vaga${t.spots_left === 1 ? '' : 's'} restante${t.spots_left === 1 ? '' : 's'}`}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-3 border-t pt-4">
            <div>
              <Label className="text-sm">Nome <span className="text-red-500">*</span></Label>
              <Input className="mt-1" value={customer.full_name}
                onChange={e => setCustomer(c => ({ ...c, full_name: e.target.value }))} />
            </div>
            <div>
              <Label className="text-sm">Treinador <span className="text-red-500">*</span></Label>
              <Select value={customer.coach_id || undefined}
                onValueChange={value => setCustomer(c => ({ ...c, coach_id: value }))}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione seu treinador" /></SelectTrigger>
                <SelectContent>
                  {(event.coaches || []).map(coach => (
                    <SelectItem key={coach.id} value={coach.id}>{coach.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {event.coaches?.length === 0 && (
                <p className="mt-1 text-xs text-amber-700">Nenhum treinador disponível para inscrição pública.</p>
              )}
            </div>
          </div>

          {selectedType && visibleDynamicFields(selectedType.form_fields || []).length > 0 && (
            <div className="border-t pt-4">
              <DynamicFields fields={selectedType.form_fields} answers={answers} onChange={setAnswers} />
            </div>
          )}

          <Button className="w-full h-11" onClick={submit} disabled={sending || !typeId || soldOut || event.coaches?.length === 0}>
            {sending ? 'Enviando...' : soldOut ? 'Vagas esgotadas' : 'Confirmar inscrição'}
          </Button>
        </CardContent></Card>

        <p className="text-center text-xs text-muted-foreground">Endurance ON · Gestão &amp; Assessoria</p>
      </div>
    </div>
  );
}

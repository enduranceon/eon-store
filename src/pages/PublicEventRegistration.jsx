import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CalendarDays, CheckCircle2, MapPin, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { createPublicEventRegistration, getPublicEvent } from '@/api/public';
import { formatCurrency, formatDate } from '@/lib/utils';
import { toast } from 'sonner';

// Renderiza o formulário definido pelo tipo de inscrição escolhido. Nome,
// WhatsApp e CPF são pedidos separadamente (campos nativos da inscrição),
// então o organizador não precisa criá-los como campos do formulário.
function DynamicFields({ fields, answers, onChange }) {
  if (!fields?.length) return null;
  return (
    <div className="space-y-3">
      {fields.map(field => {
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
  const [customer, setCustomer] = useState({ full_name: '', whatsapp: '', email: '', cpf: '' });
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

  const submit = async () => {
    if (!typeId) return toast.error('Escolha o tipo de inscrição');
    if (!customer.full_name.trim()) return toast.error('Informe seu nome completo');
    if (!customer.whatsapp.trim()) return toast.error('Informe seu WhatsApp');
    setSending(true);
    try {
      const result = await createPublicEventRegistration({
        event_slug: slug,
        registration_type_id: typeId,
        customer: {
          full_name: customer.full_name.trim(),
          whatsapp: customer.whatsapp.trim(),
          email: customer.email.trim() || null,
          cpf: customer.cpf.trim() || null,
        },
        form_answers: answers,
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

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-lg mx-auto space-y-4">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">{event.name}</h1>
          <div className="mt-2 flex items-center justify-center gap-4 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><CalendarDays className="w-4 h-4" /> {formatDate(event.event_date)}</span>
            {event.location && <span className="inline-flex items-center gap-1.5"><MapPin className="w-4 h-4" /> {event.location}</span>}
          </div>
          {event.description && <p className="mt-3 text-sm text-gray-700">{event.description}</p>}
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
              <Label className="text-sm">Nome completo <span className="text-red-500">*</span></Label>
              <Input className="mt-1" value={customer.full_name}
                onChange={e => setCustomer(c => ({ ...c, full_name: e.target.value }))} />
            </div>
            <div>
              <Label className="text-sm">WhatsApp <span className="text-red-500">*</span></Label>
              <Input className="mt-1" placeholder="(48) 99999-9999" value={customer.whatsapp}
                onChange={e => setCustomer(c => ({ ...c, whatsapp: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-sm">E-mail</Label>
                <Input className="mt-1" type="email" value={customer.email}
                  onChange={e => setCustomer(c => ({ ...c, email: e.target.value }))} />
              </div>
              <div>
                <Label className="text-sm">CPF</Label>
                <Input className="mt-1" value={customer.cpf}
                  onChange={e => setCustomer(c => ({ ...c, cpf: e.target.value }))} />
              </div>
            </div>
          </div>

          {selectedType && (selectedType.form_fields || []).length > 0 && (
            <div className="border-t pt-4">
              <DynamicFields fields={selectedType.form_fields} answers={answers} onChange={setAnswers} />
            </div>
          )}

          <Button className="w-full h-11" onClick={submit} disabled={sending || !typeId || soldOut}>
            {sending ? 'Enviando...' : soldOut ? 'Vagas esgotadas' : 'Confirmar inscrição'}
          </Button>
        </CardContent></Card>

        <p className="text-center text-xs text-muted-foreground">Endurance ON · Gestão &amp; Assessoria</p>
      </div>
    </div>
  );
}

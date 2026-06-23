import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Phone, Mail, FileText, Plus, ChevronRight, IdCard, MessageCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  PreSaleCustomer, AssessmentContract, AssessmentCoach,
  AssessmentPlan, AssessmentModality, AssessmentLeave, AssessmentContractEvent,
} from '@/api/entities';
import { supabase } from '@/api/db';
import { COMMUNICATION_EVENT_TYPES } from '@/lib/communication-tasks';
import CommunicationHistory from '@/components/CommunicationHistory';
import { formatCurrency, formatDate } from '@/lib/utils';

const STATUS = {
  active:    'bg-green-100 text-green-700',
  overdue:   'bg-red-100 text-red-700',
  on_leave:  'bg-amber-100 text-amber-700',
  finished:  'bg-gray-100 text-gray-600',
  cancelled: 'bg-red-100 text-red-500',
  voided:    'bg-amber-100 text-amber-700',
};

const STATUS_LABEL = {
  active: 'Ativo',
  overdue: 'Atrasado',
  on_leave: 'Licença',
  finished: 'Concluído',
  cancelled: 'Cancelado',
  voided: 'Descartado',
};

export default function StudentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [customer, setCustomer] = useState(null);
  const [contracts, setContracts] = useState([]);
  const [coaches, setCoaches] = useState([]);
  const [plans, setPlans] = useState([]);
  const [modalities, setModalities] = useState([]);
  const [leaves, setLeaves] = useState([]);
  const [commEvents, setCommEvents] = useState([]);
  const [currentUserId, setCurrentUserId] = useState(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [s, c, allCoaches, allPlans, allMod, authRes] = await Promise.all([
          PreSaleCustomer.get(id),
          AssessmentContract.filter({ customer_id: id }, '-created_at').catch(() => []),
          AssessmentCoach.list().catch(() => []),
          AssessmentPlan.list().catch(() => []),
          AssessmentModality.list().catch(() => []),
          supabase.auth.getUser().catch(() => null),
        ]);
        setCustomer(s); setContracts(c); setCoaches(allCoaches); setPlans(allPlans); setModalities(allMod);
        setCurrentUserId(authRes?.data?.user?.id || null);
        if (c.length > 0) {
          const contractIds = c.map(co => co.id);
          const [allLeaves, events] = await Promise.all([
            Promise.all(c.map(co => AssessmentLeave.filter({ contract_id: co.id }).catch(() => []))),
            AssessmentContractEvent.filter(
              { contract_id: contractIds, event_type: COMMUNICATION_EVENT_TYPES },
              '-created_at',
            ).catch(() => []),
          ]);
          setLeaves(allLeaves.flat().sort((a, b) => b.start_date.localeCompare(a.start_date)));
          setCommEvents(events);
        }
      } catch (e) {
        console.error('Erro ao carregar aluno:', e);
      }
    };
    load();
  }, [id]);

  if (!customer) return <div className="p-8 text-center text-muted-foreground">Carregando...</div>;

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/assessoria/alunos')}><ArrowLeft className="w-4 h-4" /></Button>
        <div>
          <h2 className="text-xl font-bold">{customer.full_name}</h2>
          <p className="text-sm text-muted-foreground flex items-center gap-3 flex-wrap">
            {customer.whatsapp && <span className="flex items-center gap-1"><Phone className="w-3 h-3" /> {customer.whatsapp}</span>}
            {customer.email && <span className="flex items-center gap-1"><Mail className="w-3 h-3" /> {customer.email}</span>}
            {customer.cpf && <span className="flex items-center gap-1"><IdCard className="w-3 h-3" /> {customer.cpf}</span>}
            <Badge variant={customer.active !== false ? 'success' : 'secondary'}>{customer.active !== false ? 'Ativo' : 'Inativo'}</Badge>
          </p>
        </div>
      </div>

      {/* Contratos */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2"><FileText className="w-4 h-4" /> Contratos ({contracts.length})</CardTitle>
            <Button size="sm" onClick={() => navigate('/assessoria/contratos/novo')}><Plus className="w-3.5 h-3.5 mr-1" /> Novo contrato</Button>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {contracts.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Sem contratos ainda</p>
          ) : (
            <div className="divide-y">
              {contracts.map(c => {
                const coach = coaches.find(co => co.id === c.coach_id);
                const plan = plans.find(p => p.id === c.plan_id);
                const mod = plan && modalities.find(m => m.id === plan.modality_id);
                return (
                  <Link key={c.id} to={`/assessoria/contratos/${c.id}`} className="flex items-center gap-3 py-2.5 hover:bg-gray-50 px-2 rounded -mx-2">
                    <div className="flex-1">
                      <p className="font-mono text-xs font-semibold text-blue-700">{c.contract_number}</p>
                      <p className="text-sm">
                        <span className="capitalize">{mod?.name}</span> · <span className="capitalize">{plan?.period}</span> · com {coach?.name || '—'}
                      </p>
                      <p className="text-xs text-muted-foreground">{formatDate(c.start_date)} → {formatDate(c.end_date)}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-bold text-sm">{formatCurrency(plan?.price_total)}</p>
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS[c.status]}`}>
                        {STATUS_LABEL[c.status] || c.status}
                      </span>
                    </div>
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  </Link>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Histórico de contatos */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <MessageCircle className="w-4 h-4" /> Histórico de contatos ({commEvents.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <CommunicationHistory events={commEvents} currentUserId={currentUserId} />
        </CardContent>
      </Card>

      {/* Licenças */}
      {leaves.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Histórico de licenças</CardTitle></CardHeader>
          <CardContent className="pt-0">
            <div className="divide-y text-sm">
              {leaves.map(l => (
                <div key={l.id} className="flex items-center justify-between py-2">
                  <span>{formatDate(l.start_date)} → {formatDate(l.end_date)} <span className="text-xs text-muted-foreground">({l.days} dias)</span></span>
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${l.status === 'active' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600'}`}>{l.status === 'active' ? 'Ativa' : 'Encerrada'}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end">
        <Link to={`/clientes/${customer.id}`} className="text-xs text-blue-600 hover:underline">Ver perfil completo na tela Clientes →</Link>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft, Phone, Mail, FileText, Plus, ChevronRight, IdCard,
  MessageCircle, Send, Hash, Cake, MapPin,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  PreSaleCustomer, AssessmentContract, AssessmentCoach,
  AssessmentPlan, AssessmentModality, AssessmentLeave, AssessmentContractEvent,
} from '@/api/entities';
import { supabase } from '@/api/db';
import {
  COMMUNICATION_EVENT_TYPES, TASK_BUCKET, TASK_KIND,
  buildCommunicationTasks, taskChannelLabel,
} from '@/lib/communication-tasks';
import { DEFAULT_COMMUNITY_LINK, loadCommunicationConfig } from '@/lib/communication-config';
import CommunicationHistory from '@/components/CommunicationHistory';
import CommunicationSendDialog from '@/components/CommunicationSendDialog';
import { formatCurrency, formatDate } from '@/lib/utils';
import { formatCustomerAddress } from '@/lib/br-address';
import { getContractKindLabel, isRenewalContract } from '@/lib/assessment-contract-lifecycle';
import { applyAssessmentContractTransitions } from '@/lib/assessment-contract-transitions';

function taskTone(task) {
  if (task.kind === TASK_KIND.CHARGE_OVERDUE) return 'destructive';
  if (task.bucket === TASK_BUCKET.ONBOARDING) return 'success';
  if (task.bucket === TASK_BUCKET.RENEWAL) return 'purple';
  return 'info';
}

const STATUS = {
  scheduled: 'bg-blue-100 text-blue-700',
  active:    'bg-green-100 text-green-700',
  overdue:   'bg-red-100 text-red-700',
  on_leave:  'bg-amber-100 text-amber-700',
  finished:  'bg-gray-100 text-gray-600',
  cancelled: 'bg-red-100 text-red-500',
  voided:    'bg-amber-100 text-amber-700',
};

const STATUS_LABEL = {
  scheduled: 'Agendado',
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
  const [pendingTasks, setPendingTasks] = useState([]);
  const [communityLink, setCommunityLink] = useState(DEFAULT_COMMUNITY_LINK);
  const [selectedTask, setSelectedTask] = useState(null);
  const [reloadFlag, setReloadFlag] = useState(0);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [s, c, allCoaches, allPlans, allMod, authRes, config] = await Promise.all([
          PreSaleCustomer.get(id),
          AssessmentContract.filter({ customer_id: id }, '-created_at').catch(() => []),
          AssessmentCoach.list().catch(() => []),
          AssessmentPlan.list().catch(() => []),
          AssessmentModality.list().catch(() => []),
          supabase.auth.getUser().catch(() => null),
          loadCommunicationConfig().catch(() => null),
        ]);
        if (!active) return;
        await applyAssessmentContractTransitions(c);
        if (!active) return;
        setCustomer(s); setContracts(c); setCoaches(allCoaches); setPlans(allPlans); setModalities(allMod);
        setCurrentUserId(authRes?.data?.user?.id || null);
        setCommunityLink(config?.communityLink || DEFAULT_COMMUNITY_LINK);
        if (c.length === 0) {
          setLeaves([]); setCommEvents([]); setPendingTasks([]);
          return;
        }
        const contractIds = c.map(co => co.id);
        const [allLeaves, events] = await Promise.all([
          Promise.all(c.map(co => AssessmentLeave.filter({ contract_id: co.id }).catch(() => []))),
          AssessmentContractEvent.filter(
            { contract_id: contractIds, event_type: COMMUNICATION_EVENT_TYPES },
            '-created_at',
          ).catch(() => []),
        ]);
        if (!active) return;
        setLeaves(allLeaves.flat().sort((a, b) => b.start_date.localeCompare(a.start_date)));
        setCommEvents(events);
        setPendingTasks(buildCommunicationTasks(
          {
            contracts: c, customers: [s], plans: allPlans, modalities: allMod,
            coaches: allCoaches, contractEvents: events, presaleOrders: [], stockOrders: [],
          },
          { rules: config?.rules },
        ));
      } catch (e) {
        console.error('Erro ao carregar aluno:', e);
      }
    };
    load();
    return () => { active = false; };
  }, [id, reloadFlag]);

  if (!customer) return <div className="p-8 text-center text-muted-foreground">Carregando...</div>;
  const address = formatCustomerAddress(customer);

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/assessoria/alunos')}><ArrowLeft className="w-4 h-4" /></Button>
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            {customer.customer_code && (
              <span className="font-mono text-xs font-bold text-blue-700 bg-blue-50 border border-blue-100 px-1.5 py-0.5 rounded">
                {customer.customer_code}
              </span>
            )}
            <h2 className="text-xl font-bold">{customer.full_name}</h2>
          </div>
          <p className="text-sm text-muted-foreground flex items-center gap-3 flex-wrap">
            {customer.whatsapp && <span className="flex items-center gap-1"><Phone className="w-3 h-3" /> {customer.whatsapp}</span>}
            {customer.email && <span className="flex items-center gap-1"><Mail className="w-3 h-3" /> {customer.email}</span>}
            {customer.cpf && <span className="flex items-center gap-1"><IdCard className="w-3 h-3" /> {customer.cpf}</span>}
            <Badge variant={customer.active !== false ? 'success' : 'secondary'}>
              {customer.active !== false ? 'Cadastro ativo' : 'Cadastro inativo'}
            </Badge>
          </p>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><IdCard className="w-4 h-4" /> Dados cadastrais</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 text-sm">
          <div>
            <p className="text-xs text-muted-foreground flex items-center gap-1"><Hash className="w-3 h-3" /> Código</p>
            <p className="font-mono font-semibold">{customer.customer_code || '—'}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground flex items-center gap-1"><Cake className="w-3 h-3" /> Nascimento</p>
            <p className="font-semibold">{customer.birth_date ? formatDate(customer.birth_date) : '—'}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground flex items-center gap-1"><Phone className="w-3 h-3" /> Telefone</p>
            <p className="font-semibold">{customer.whatsapp || '—'}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground flex items-center gap-1"><Mail className="w-3 h-3" /> Email</p>
            <p className="font-semibold break-all">{customer.email || '—'}</p>
          </div>
          <div className="sm:col-span-2">
            <p className="text-xs text-muted-foreground flex items-center gap-1"><MapPin className="w-3 h-3" /> Endereço</p>
            <p className="font-semibold">{address || '—'}</p>
          </div>
        </CardContent>
      </Card>

      {/* Contratos */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2"><FileText className="w-4 h-4" /> Contratos ({contracts.length})</CardTitle>
            <Button size="sm" onClick={() => navigate(`/assessoria/contratos/novo?customer_id=${id}`)}><Plus className="w-3.5 h-3.5 mr-1" /> Novo contrato</Button>
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
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <p className="font-mono text-xs font-semibold text-blue-700">{c.contract_number}</p>
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                          isRenewalContract(c) ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
                        }`}>
                          {getContractKindLabel(c)}
                        </span>
                      </div>
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

      {/* Ações de comunicação pendentes */}
      {pendingTasks.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Send className="w-4 h-4" /> Ações de comunicação ({pendingTasks.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <ul className="divide-y">
              {pendingTasks.map(task => (
                <li key={task.id} className="py-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={taskTone(task)}>{taskChannelLabel(task)}</Badge>
                      <span className="text-sm font-semibold">{task.title}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      <span className="font-mono">{task.orderNumber}</span>
                      {task.statusLabel ? ` · ${task.statusLabel}` : ''}
                    </p>
                  </div>
                  <Button size="sm" className="gap-1.5 shrink-0" onClick={() => setSelectedTask(task)}>
                    <MessageCircle className="w-4 h-4" /> Preparar
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

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

      <CommunicationSendDialog
        key={selectedTask?.id || 'none'}
        task={selectedTask}
        communityLink={communityLink}
        onClose={() => setSelectedTask(null)}
        onSent={() => { setSelectedTask(null); setReloadFlag(f => f + 1); }}
      />
    </div>
  );
}

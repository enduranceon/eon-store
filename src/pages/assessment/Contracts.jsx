import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, FileText, ChevronRight, RefreshCcw } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import {
  AssessmentContract, PreSaleCustomer, AssessmentCoach,
  AssessmentPlan, AssessmentModality,
} from '@/api/entities';
import { formatCurrency, formatDate } from '@/lib/utils';
import { usePageData } from '@/hooks/usePageData';
import { getContractKindLabel, isRenewalContract } from '@/lib/assessment-contract-lifecycle';
import { applyAssessmentContractTransitions } from '@/lib/assessment-contract-transitions';

const STATUS = {
  scheduled: { label: 'Agendado',  cls: 'bg-blue-100 text-blue-700' },
  active:    { label: 'Ativo',     cls: 'bg-green-100 text-green-700' },
  overdue:   { label: 'Atrasado',  cls: 'bg-red-100 text-red-700' },
  on_leave:  { label: 'Licença',   cls: 'bg-amber-100 text-amber-700' },
  finished:  { label: 'Concluído', cls: 'bg-gray-100 text-gray-600' },
  cancelled: { label: 'Cancelado', cls: 'bg-red-100 text-red-500' },
  voided:    { label: 'Descartado', cls: 'bg-amber-100 text-amber-700' },
};

const PAY = {
  pending:            { label: 'Aguardando', cls: 'bg-gray-100 text-gray-600' },
  paid:               { label: 'Pago',       cls: 'bg-green-100 text-green-700' },
  overdue:            { label: 'Vencido',    cls: 'bg-red-100 text-red-700' },
  refunded:           { label: 'Estornado',  cls: 'bg-gray-100 text-gray-500' },
  partially_refunded: { label: 'Est. parcial', cls: 'bg-amber-100 text-amber-700' },
};

async function loadContractsPage() {
  const [contracts, students, coaches, plans, modalities] = await Promise.all([
    AssessmentContract.list('-created_at').catch(() => []),
    PreSaleCustomer.list().catch(() => []),
    AssessmentCoach.list().catch(() => []),
    AssessmentPlan.list().catch(() => []),
    AssessmentModality.list().catch(() => []),
  ]);
  await applyAssessmentContractTransitions(contracts);
  return { contracts, students, coaches, plans, modalities };
}

export default function Contracts() {
  const navigate = useNavigate();
  const {
    data: { contracts, students, coaches, plans, modalities },
  } = usePageData({
    key: 'assessment-contracts:list',
    loader: loadContractsPage,
    initialData: { contracts: [], students: [], coaches: [], plans: [], modalities: [] },
    tags: [
      'assessment_contracts',
      'presale_customers',
      'assessment_coaches',
      'assessment_plans',
      'assessment_modalities',
    ],
    onError: error => console.error('Erro ao carregar contratos:', error),
  });
  const [search, setSearch] = useState('');
  const [statusF, setStatusF] = useState('all');
  const [modalityF, setModalityF] = useState('all');
  const [coachF, setCoachF] = useState('all');

  const enriched = contracts.map(c => {
    const plan = plans.find(p => p.id === c.plan_id);
    const modality = plan ? modalities.find(m => m.id === plan.modality_id) : null;
    return {
      ...c,
      student: students.find(s => s.id === c.customer_id),
      coach:   coaches.find(co => co.id === c.coach_id),
      plan, modality,
    };
  });

  // Drafts vão pra página dedicada — escondemos aqui
  const drafts           = enriched.filter(c => c.status === 'draft');
  const draftEnrollments = drafts.filter(c => !c.parent_contract_id);
  const draftRenewals    = drafts.filter(c =>  c.parent_contract_id);

  const filtered = enriched.filter(c => {
    if (c.status === 'draft') return false;
    if (statusF !== 'all' && c.status !== statusF) return false;
    if (modalityF !== 'all' && c.modality?.id !== modalityF) return false;
    if (coachF !== 'all' && c.coach_id !== coachF) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!c.contract_number?.toLowerCase().includes(q) &&
          !c.student?.full_name?.toLowerCase().includes(q) &&
          !c.coach?.name?.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Contratos</h2>
          <p className="text-sm text-muted-foreground">{filtered.length} contrato{filtered.length !== 1 ? 's' : ''}</p>
        </div>
        <Button onClick={() => navigate('/assessoria/contratos/novo')}><Plus className="w-4 h-4 mr-2" /> Novo contrato</Button>
      </div>

      {/* Faixa: prospects pendentes */}
      {draftEnrollments.length > 0 && (
        <Card className="border-green-300 bg-green-50/40 cursor-pointer hover:bg-green-50 transition-colors"
          onClick={() => navigate('/assessoria/prospects')}>
          <CardContent className="p-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-full bg-green-100"><RefreshCcw className="w-4 h-4 text-green-700" /></div>
              <div>
                <p className="text-sm font-semibold text-green-900">
                  {draftEnrollments.length} prospect{draftEnrollments.length !== 1 ? 's' : ''} aguardando confirmação
                </p>
                <p className="text-xs text-green-700">Clique para revisar e confirmar</p>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-green-700" />
          </CardContent>
        </Card>
      )}

      {/* Faixa: renovações pendentes */}
      {draftRenewals.length > 0 && (
        <Card className="border-blue-300 bg-blue-50/40 cursor-pointer hover:bg-blue-50 transition-colors"
          onClick={() => navigate('/assessoria/renovacoes')}>
          <CardContent className="p-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-full bg-blue-100"><RefreshCcw className="w-4 h-4 text-blue-700" /></div>
              <div>
                <p className="text-sm font-semibold text-blue-900">
                  {draftRenewals.length} renovação{draftRenewals.length !== 1 ? 'ões' : ''} aguardando aprovação
                </p>
                <p className="text-xs text-blue-700">Clique para revisar e ativar</p>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-blue-700" />
          </CardContent>
        </Card>
      )}

      {/* Filtros */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative max-w-xs flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Buscar contrato / aluno / coach..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <Select value={statusF} onValueChange={setStatusF}>
          <SelectTrigger className="w-36"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos status</SelectItem>
            {Object.entries(STATUS).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={modalityF} onValueChange={setModalityF}>
          <SelectTrigger className="w-36"><SelectValue placeholder="Modalidade" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas modalidades</SelectItem>
            {modalities.map(m => <SelectItem key={m.id} value={m.id} className="capitalize">{m.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={coachF} onValueChange={setCoachF}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Coach" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos coaches</SelectItem>
            {coaches.map(co => <SelectItem key={co.id} value={co.id}>{co.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <Card><CardContent className="flex flex-col items-center py-16 text-center">
          <FileText className="w-10 h-10 text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground">Nenhum contrato encontrado</p>
          <Button className="mt-4" onClick={() => navigate('/assessoria/contratos/novo')}>Criar primeiro contrato</Button>
        </CardContent></Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Contrato</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Aluno</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Coach</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Plano</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Valor</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Vencimento</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Pagamento</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map(c => {
                const st = STATUS[c.status] || { label: c.status, cls: '' };
                const pa = PAY[c.payment_status] || { label: c.payment_status, cls: '' };
                return (
                  <tr key={c.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => navigate(`/assessoria/contratos/${c.id}`)}>
                    <td className="px-4 py-3">
                      <p className="font-mono text-xs font-semibold text-blue-700">{c.contract_number}</p>
                      <span className={`mt-1 inline-flex text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                        isRenewalContract(c) ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
                      }`}>
                        {getContractKindLabel(c)}
                      </span>
                    </td>
                    <td className="px-4 py-3">{c.student?.full_name || '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{c.coach?.name || '—'}</td>
                    <td className="px-4 py-3 text-xs">
                      <p className="capitalize font-medium">{c.modality?.name}</p>
                      <p className="text-muted-foreground capitalize">{c.plan?.period}</p>
                    </td>
                    <td className="px-4 py-3 text-right font-semibold">{formatCurrency(c.plan_snapshot?.price_total ?? c.plan?.price_total)}</td>
                    <td className="px-4 py-3 text-right text-xs text-muted-foreground">{formatDate(c.end_date)}</td>
                    <td className="px-4 py-3 text-center"><span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span></td>
                    <td className="px-4 py-3 text-center"><span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${pa.cls}`}>{pa.label}</span></td>
                    <td className="px-4 py-3"><ChevronRight className="w-4 h-4 text-muted-foreground" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

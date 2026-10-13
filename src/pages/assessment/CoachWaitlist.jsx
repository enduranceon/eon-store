import { Link } from 'react-router-dom';
import CoachWaitlistPanel from '@/components/assessment/CoachWaitlistPanel';

export default function CoachWaitlist() {
  return (
    <div className="space-y-5 pb-8">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Lista de espera</h2>
        <p className="text-sm text-muted-foreground">
          Quem quer treinar com um coach que está cheio. Converse com a pessoa, consulte o coach, ofereça outro coach
          ou crie o prospect. Para abrir ou fechar a lista de um coach, edite o coach em{' '}
          <Link to="/assessoria/coaches" className="text-blue-700 hover:underline">Equipe</Link>.
        </p>
      </div>
      <CoachWaitlistPanel />
    </div>
  );
}

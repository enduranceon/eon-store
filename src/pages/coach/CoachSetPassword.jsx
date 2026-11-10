import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Check, Circle, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/api/db';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { mustChangePassword } from '@/lib/auth-role';
import { firstNameOf } from '@/lib/coach-access';
import { cn } from '@/lib/utils';

const MIN_LENGTH = 8;

function PasswordField({ id, label, value, onChange, autoComplete }) {
  const [visible, setVisible] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium text-slate-800">{label}</label>
      <div className="relative mt-1.5">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          value={value}
          onChange={event => onChange(event.target.value)}
          className="h-12 w-full rounded-xl border border-slate-200 bg-white px-3.5 pr-12 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
        />
        <button
          type="button"
          onClick={() => setVisible(current => !current)}
          aria-label={visible ? 'Ocultar senha' : 'Mostrar senha'}
          aria-pressed={visible}
          className="absolute right-1.5 top-1/2 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
        >
          {visible ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}

function Requirement({ ok, children }) {
  return (
    <li className={cn('flex items-center gap-2 text-sm transition-colors', ok ? 'text-emerald-700' : 'text-slate-500')}>
      {ok ? <Check className="h-4 w-4" aria-hidden="true" /> : <Circle className="h-4 w-4" aria-hidden="true" />}
      {children}
      <span className="sr-only">{ok ? ' (cumprido)' : ' (pendente)'}</span>
    </li>
  );
}

// Troca de senha do coach. No primeiro acesso (senha provisória da equipe) é obrigatória.
export default function CoachSetPassword() {
  const navigate = useNavigate();
  const { user, coach } = useAuth();
  const forced = mustChangePassword(user);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState('');

  const longEnough = password.length >= MIN_LENGTH;
  const matches = password.length > 0 && password === confirm;

  async function submit(event) {
    event.preventDefault();
    if (!longEnough) return setProblem(`A senha precisa ter pelo menos ${MIN_LENGTH} caracteres.`);
    if (!matches) return setProblem('As duas senhas não são iguais.');
    setProblem('');
    setSaving(true);
    const { error } = await supabase.auth.updateUser({ password, data: { must_change_password: false } });
    setSaving(false);
    if (error) {
      return setProblem(error.message?.toLowerCase().includes('different')
        ? 'Escolha uma senha diferente da atual.'
        : 'Não foi possível trocar a senha. Tente novamente.');
    }
    toast.success('Senha atualizada');
    navigate('/coach', { replace: true });
  }

  const first = firstNameOf(coach?.name);
  return (
    <div className="mx-auto max-w-md space-y-5 py-2 sm:py-6">
      <div className="text-center">
        <span className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-md">
          <ShieldCheck className="h-7 w-7" aria-hidden="true" />
        </span>
        <h1 className="mt-4 text-2xl font-bold tracking-tight text-slate-900">
          {forced ? `Bem-vindo${first ? `, ${first}` : ''}!` : 'Trocar senha'}
        </h1>
        <p className="mt-1.5 text-sm text-slate-600">
          {forced
            ? 'Este é o seu primeiro acesso. Crie uma senha só sua no lugar da provisória para continuar.'
            : 'Escolha uma senha nova para a sua conta.'}
        </p>
      </div>

      <form onSubmit={submit} className="space-y-4 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6" noValidate>
        <PasswordField id="coach-new-password" label="Senha nova" value={password} onChange={setPassword} autoComplete="new-password" />
        <PasswordField id="coach-confirm-password" label="Repita a senha" value={confirm} onChange={setConfirm} autoComplete="new-password" />
        <ul className="space-y-1.5 rounded-xl bg-slate-50 p-3" aria-label="Requisitos da senha">
          <Requirement ok={longEnough}>Pelo menos {MIN_LENGTH} caracteres</Requirement>
          <Requirement ok={matches}>As duas senhas são iguais</Requirement>
        </ul>
        {problem && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{problem}</p>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          {!forced && <Button asChild variant="outline" className="h-11 flex-1 rounded-xl"><Link to="/coach">Cancelar</Link></Button>}
          <Button type="submit" className="h-11 flex-1 rounded-xl text-base" disabled={saving}>{saving ? 'Salvando...' : 'Salvar senha'}</Button>
        </div>
      </form>
    </div>
  );
}

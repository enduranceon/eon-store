import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { supabase } from '@/api/db';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/useAuth';
import { mustChangePassword } from '@/lib/auth-role';

const MIN_LENGTH = 8;

// Troca de senha do coach. No primeiro acesso (senha provisória da equipe) é obrigatória.
export default function CoachSetPassword() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const forced = mustChangePassword(user);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState('');

  async function submit(event) {
    event.preventDefault();
    if (password.length < MIN_LENGTH) return setProblem(`A senha precisa ter pelo menos ${MIN_LENGTH} caracteres.`);
    if (password !== confirm) return setProblem('As duas senhas não são iguais.');
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

  return (
    <div className="mx-auto max-w-sm space-y-4">
      <div>
        <h1 className="text-xl font-bold text-gray-900">{forced ? 'Crie sua senha' : 'Trocar senha'}</h1>
        <p className="text-sm text-muted-foreground">
          {forced
            ? 'Este é o seu primeiro acesso. Troque a senha provisória por uma só sua para continuar.'
            : 'Escolha uma senha nova para a sua conta.'}
        </p>
      </div>
      <Card><CardContent className="p-4">
        <form onSubmit={submit} className="space-y-3">
          <div>
            <Label htmlFor="coach-new-password">Senha nova</Label>
            <Input id="coach-new-password" type="password" autoComplete="new-password" className="mt-1" value={password} onChange={e => setPassword(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="coach-confirm-password">Repita a senha</Label>
            <Input id="coach-confirm-password" type="password" autoComplete="new-password" className="mt-1" value={confirm} onChange={e => setConfirm(e.target.value)} />
          </div>
          {problem && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{problem}</p>}
          <div className="flex gap-2">
            {!forced && <Button asChild variant="outline" className="flex-1"><Link to="/coach">Cancelar</Link></Button>}
            <Button type="submit" className="flex-1" disabled={saving}>{saving ? 'Salvando...' : 'Salvar senha'}</Button>
          </div>
        </form>
      </CardContent></Card>
    </div>
  );
}

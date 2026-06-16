import { Component } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Captura erros de renderização das páginas para evitar "tela branca".
// Mantém o layout ao redor (sidebar/topbar) e mostra o erro + opção de recarregar.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack);
  }

  componentDidUpdate(prevProps) {
    // Ao trocar de rota, limpa o erro pra tentar renderizar a nova página
    if (prevProps.routeKey !== this.props.routeKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="max-w-xl mx-auto mt-10">
          <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-center">
            <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-3">
              <AlertTriangle className="w-6 h-6 text-red-600" />
            </div>
            <h2 className="text-lg font-bold text-red-900">Algo deu errado nesta tela</h2>
            <p className="text-sm text-red-700 mt-1">
              A página encontrou um erro e não pôde ser exibida. Você pode recarregar ou navegar para outra tela pelo menu.
            </p>
            <pre className="text-left text-xs text-red-800 bg-white/70 border border-red-200 rounded-lg p-3 mt-4 overflow-x-auto whitespace-pre-wrap">
              {this.state.error?.message || String(this.state.error)}
            </pre>
            <Button className="mt-4" onClick={() => window.location.reload()}>
              <RefreshCw className="w-4 h-4 mr-1.5" /> Recarregar
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider } from '@/components/AuthProvider';
import ErrorBoundary from '@/components/ErrorBoundary';
import RouteFallback from '@/components/RouteFallback';

const AdminLayout = lazy(() => import('@/components/layout/AdminLayout'));
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const Campaigns = lazy(() => import('@/pages/Campaigns'));
const CampaignDetail = lazy(() => import('@/pages/CampaignDetail'));
const ProductLibrary = lazy(() => import('@/pages/ProductLibrary'));
const Products = lazy(() => import('@/pages/Products'));
const ProductForm = lazy(() => import('@/pages/ProductForm'));
const OrderDetail = lazy(() => import('@/pages/OrderDetail'));
const OrderCenter = lazy(() => import('@/pages/OrderCenter'));
const Events = lazy(() => import('@/pages/Events'));
const PublicEventRegistration = lazy(() => import('@/pages/PublicEventRegistration'));
const EventDetail = lazy(() => import('@/pages/EventDetail'));
const Customers = lazy(() => import('@/pages/Customers'));
const CustomerDetail = lazy(() => import('@/pages/CustomerDetail'));
const Suppliers = lazy(() => import('@/pages/Suppliers'));
const SupplierForm = lazy(() => import('@/pages/SupplierForm'));
const Categories = lazy(() => import('@/pages/Categories'));
const Trainers = lazy(() => import('@/pages/Trainers'));
const PublicCheckout = lazy(() => import('@/pages/PublicCheckout'));
const PublicOrderConfirmation = lazy(() => import('@/pages/PublicOrderConfirmation'));
const PublicHome = lazy(() => import('@/pages/PublicHome'));
const Migrate = lazy(() => import('@/pages/Migrate'));
const CampaignReport = lazy(() => import('@/pages/CampaignReport'));
const Login = lazy(() => import('@/pages/Login'));
const StockMovements = lazy(() => import('@/pages/StockMovements'));
const ProductStockManager = lazy(() => import('@/pages/ProductStockManager'));
const ProductStockSetup = lazy(() => import('@/pages/ProductStockSetup'));
const StockOrderDetail = lazy(() => import('@/pages/StockOrderDetail'));
const PublicStore = lazy(() => import('@/pages/PublicStore'));
const PublicStoreConfirmation = lazy(() => import('@/pages/PublicStoreConfirmation'));
const Financial = lazy(() => import('@/pages/Financial'));
const Returns = lazy(() => import('@/pages/Returns'));
const Refunds = lazy(() => import('@/pages/Refunds'));
const Today = lazy(() => import('@/pages/Today'));
const CommunicationCenter = lazy(() => import('@/pages/CommunicationCenter'));
const CommunicationSettings = lazy(() => import('@/pages/CommunicationSettings'));
const Coupons = lazy(() => import('@/pages/Coupons'));
const CouponForm = lazy(() => import('@/pages/CouponForm'));
const RevenueCenters = lazy(() => import('@/pages/RevenueCenters'));
const PaymentMethodsConfig = lazy(() => import('@/pages/PaymentMethodsConfig'));
const HealthCheck = lazy(() => import('@/pages/admin/HealthCheck'));
const StockOrderNewAdmin = lazy(() => import('@/pages/StockOrderNewAdmin'));
const PublicOrderTracking = lazy(() => import('@/pages/PublicOrderTracking'));
const PublicPlanEnrollment = lazy(() => import('@/pages/public/PublicPlanEnrollment'));
const PublicModalityPlans = lazy(() => import('@/pages/public/PublicModalityPlans'));

// Assessoria
const AssConfiguracoes = lazy(() => import('@/pages/assessment/Configuracoes'));
const AssPlanos = lazy(() => import('@/pages/assessment/Planos'));
const AssCoaches = lazy(() => import('@/pages/assessment/Coaches'));
const AssStudents = lazy(() => import('@/pages/assessment/Students'));
const AssStudentDetail = lazy(() => import('@/pages/assessment/StudentDetail'));
const AssContracts = lazy(() => import('@/pages/assessment/Contracts'));
const AssContractForm = lazy(() => import('@/pages/assessment/ContractForm'));
const AssContractDetail = lazy(() => import('@/pages/assessment/ContractDetail'));
const AssMonthlyClosing = lazy(() => import('@/pages/assessment/MonthlyClosing'));
const AssClosingDetail = lazy(() => import('@/pages/assessment/ClosingDetail'));
const AssCoachStatement = lazy(() => import('@/pages/assessment/CoachStatement'));
const AssRenewals = lazy(() => import('@/pages/assessment/Renewals'));
const AssProspects = lazy(() => import('@/pages/assessment/Prospects'));
const AssRepasse = lazy(() => import('@/pages/assessment/Repasse'));
const AssContractAudit = lazy(() => import('@/pages/assessment/ContractAudit'));
const AssLeaves = lazy(() => import('@/pages/assessment/Leaves'));
const Reports = lazy(() => import('@/pages/Reports'));
const Analytics = lazy(() => import('@/pages/Analytics'));
const CashFlow = lazy(() => import('@/pages/CashFlow'));
const FinancialReconciliation = lazy(() => import('@/pages/FinancialReconciliation'));
const AssPainel = lazy(() => import('@/pages/assessment/Painel'));
const AssIndicators = lazy(() => import('@/pages/assessment/Indicators'));
const AssCentralFinanceira = lazy(() => import('@/pages/assessment/CentralFinanceira'));

function LegacyOrderListRedirect({ origin }) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  params.set('origem', origin);

  return <Navigate to={`/pedidos?${params.toString()}${location.hash}`} replace />;
}

function RouteErrorBoundary({ children }) {
  const location = useLocation();

  return <ErrorBoundary routeKey={location.pathname}>{children}</ErrorBoundary>;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Toaster position="top-right" richColors />
        <RouteErrorBoundary>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
          {/* Públicas */}
          <Route path="/" element={<PublicHome />} />
          <Route path="/checkout/:campaignId" element={<PublicCheckout />} />
          <Route path="/confirmacao/:orderId" element={<PublicOrderConfirmation />} />
          <Route path="/loja" element={<PublicStore />} />
          <Route path="/loja/confirmacao/:orderId" element={<PublicStoreConfirmation />} />
          <Route path="/p/:orderId" element={<PublicOrderTracking />} />
          <Route path="/assinar/:planId" element={<PublicPlanEnrollment />} />
          <Route path="/inscricao/:slug" element={<PublicEventRegistration />} />
          <Route path="/planos/:modalityId" element={<PublicModalityPlans />} />

          {/* Admin */}
          <Route path="/login" element={<Login />} />
          <Route path="/migrar" element={<AdminLayout><Migrate /></AdminLayout>} />
          <Route path="/admin" element={<AdminLayout><Dashboard /></AdminLayout>} />
          <Route path="/hoje" element={<AdminLayout><Today /></AdminLayout>} />
          <Route path="/comunicacao" element={<AdminLayout><CommunicationCenter /></AdminLayout>} />
          <Route path="/comunicacao/configuracoes" element={<AdminLayout><CommunicationSettings /></AdminLayout>} />
          <Route path="/campanhas" element={<AdminLayout><Campaigns /></AdminLayout>} />
          <Route path="/campanhas/:id" element={<AdminLayout><CampaignDetail /></AdminLayout>} />
	          <Route path="/campanhas/:id/relatorio" element={<AdminLayout><CampaignReport /></AdminLayout>} />
	          <Route path="/biblioteca-produtos" element={<Navigate to="/produtos" replace />} />
	          <Route path="/produtos" element={<AdminLayout><ProductLibrary /></AdminLayout>} />
          <Route path="/produtos/pre-venda" element={<AdminLayout><Products /></AdminLayout>} />
          <Route path="/produtos/pre-venda/novo" element={<AdminLayout><ProductForm mode="presale" /></AdminLayout>} />
          <Route path="/produtos/pre-venda/:id" element={<AdminLayout><ProductForm mode="presale" /></AdminLayout>} />
          <Route path="/produtos/estoque/:stockId" element={<AdminLayout><ProductStockManager /></AdminLayout>} />
          <Route path="/produtos/:productId/estoque/configurar" element={<AdminLayout><ProductStockSetup /></AdminLayout>} />
          <Route path="/produtos/novo" element={<AdminLayout><ProductForm mode="catalog" /></AdminLayout>} />
          <Route path="/produtos/:id" element={<AdminLayout><ProductForm mode="catalog" /></AdminLayout>} />
          <Route path="/pedidos" element={<AdminLayout><OrderCenter /></AdminLayout>} />
          <Route path="/eventos" element={<AdminLayout><Events /></AdminLayout>} />
          <Route path="/eventos/:id" element={<AdminLayout><EventDetail /></AdminLayout>} />
          <Route path="/pedidos/pre-venda" element={<LegacyOrderListRedirect origin="presale" />} />
          <Route path="/pedidos/:id" element={<AdminLayout><OrderDetail /></AdminLayout>} />
          <Route path="/clientes" element={<AdminLayout><Customers /></AdminLayout>} />
          <Route path="/clientes/:id" element={<AdminLayout><CustomerDetail /></AdminLayout>} />
          <Route path="/categorias" element={<AdminLayout><Categories /></AdminLayout>} />
          <Route path="/treinadores" element={<AdminLayout><Trainers /></AdminLayout>} />
          <Route path="/fornecedores" element={<AdminLayout><Suppliers /></AdminLayout>} />
          <Route path="/fornecedores/novo" element={<AdminLayout><SupplierForm /></AdminLayout>} />
          <Route path="/fornecedores/:id" element={<AdminLayout><SupplierForm /></AdminLayout>} />
          <Route path="/relatorios" element={<AdminLayout><Reports /></AdminLayout>} />
          <Route path="/analytics" element={<AdminLayout><Analytics /></AdminLayout>} />
          <Route path="/financeiro/conciliacao" element={<AdminLayout><FinancialReconciliation /></AdminLayout>} />
          <Route path="/financeiro" element={<AdminLayout><Financial /></AdminLayout>} />
          <Route path="/financeiro/fluxo-caixa" element={<AdminLayout><CashFlow /></AdminLayout>} />
          <Route path="/devolucoes" element={<AdminLayout><Returns /></AdminLayout>} />
          <Route path="/estornos" element={<AdminLayout><Refunds /></AdminLayout>} />
          <Route path="/cupons" element={<AdminLayout><Coupons /></AdminLayout>} />
          <Route path="/cupons/novo" element={<AdminLayout><CouponForm /></AdminLayout>} />
          <Route path="/cupons/:id" element={<AdminLayout><CouponForm /></AdminLayout>} />
          <Route path="/centros-receita" element={<AdminLayout><RevenueCenters /></AdminLayout>} />
          <Route path="/configuracoes/pagamento" element={<AdminLayout><PaymentMethodsConfig /></AdminLayout>} />
          <Route path="/admin/saude" element={<AdminLayout><HealthCheck /></AdminLayout>} />

          {/* Assessoria */}
          <Route path="/assessoria"               element={<AdminLayout><AssPainel /></AdminLayout>} />
          <Route path="/assessoria/indicadores"   element={<AdminLayout><AssIndicators /></AdminLayout>} />
          <Route path="/assessoria/planos"        element={<AdminLayout><AssPlanos /></AdminLayout>} />
          {/* A antiga "Régua" foi absorvida pela Central de Comunicação (regras) e Renovações */}
          <Route path="/assessoria/regua"         element={<Navigate to="/comunicacao/configuracoes" replace />} />
          <Route path="/assessoria/configuracoes" element={<AdminLayout><AssConfiguracoes /></AdminLayout>} />
          <Route path="/assessoria/coaches"       element={<AdminLayout><AssCoaches /></AdminLayout>} />
          <Route path="/assessoria/alunos"        element={<AdminLayout><AssStudents /></AdminLayout>} />
          <Route path="/assessoria/alunos/:id"    element={<AdminLayout><AssStudentDetail /></AdminLayout>} />
          <Route path="/assessoria/contratos"     element={<AdminLayout><AssContracts /></AdminLayout>} />
          <Route path="/assessoria/contratos/novo" element={<AdminLayout><AssContractForm /></AdminLayout>} />
          <Route path="/assessoria/contratos/:id" element={<AdminLayout><AssContractDetail /></AdminLayout>} />
          <Route path="/assessoria/renovacoes"    element={<AdminLayout><AssRenewals /></AdminLayout>} />
          <Route path="/assessoria/prospects"    element={<AdminLayout><AssProspects /></AdminLayout>} />
          <Route path="/assessoria/auditoria"    element={<AdminLayout><AssContractAudit /></AdminLayout>} />
          <Route path="/assessoria/licencas"    element={<AdminLayout><AssLeaves /></AdminLayout>} />
          <Route path="/assessoria/central-financeira" element={<AdminLayout><AssCentralFinanceira /></AdminLayout>} />
          <Route path="/assessoria/repasse" element={<AdminLayout><AssRepasse /></AdminLayout>} />
          <Route path="/assessoria/fechamento"     element={<AdminLayout><AssMonthlyClosing /></AdminLayout>} />
          <Route path="/assessoria/fechamento/:id" element={<AdminLayout><AssClosingDetail /></AdminLayout>} />
          <Route path="/assessoria/fechamento/:id/extrato/:coachId" element={<Suspense fallback={<div style={{ padding: 48, textAlign: 'center', color: '#64748b' }}>Carregando extrato...</div>}><AssCoachStatement /></Suspense>} />
          <Route path="/estoque" element={<Navigate to="/produtos?visao=needs_stock" replace />} />
          <Route path="/estoque/novo" element={<Navigate to="/produtos/novo" replace />} />
          <Route path="/estoque/entrada" element={<Navigate to="/produtos" replace />} />
          <Route path="/estoque/movimentacoes" element={<AdminLayout><StockMovements /></AdminLayout>} />
          <Route path="/estoque/pedidos" element={<LegacyOrderListRedirect origin="stock" />} />
          <Route path="/estoque/pedidos/novo" element={<AdminLayout><StockOrderNewAdmin /></AdminLayout>} />
          <Route path="/estoque/pedidos/:id" element={<AdminLayout><StockOrderDetail /></AdminLayout>} />
          <Route path="/estoque/:id" element={<AdminLayout><ProductStockManager /></AdminLayout>} />
          <Route path="*" element={<Navigate to="/hoje" replace />} />
            </Routes>
          </Suspense>
        </RouteErrorBoundary>
      </BrowserRouter>
    </AuthProvider>
  );
}

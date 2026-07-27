import { db } from './db';
import { createAdminRecordEntity, createCatalogEntity, StockProductApi } from './client';

export const PreSaleCampaign  = createAdminRecordEntity('campaigns', 'presale_campaigns');
export const PreSaleProduct   = createAdminRecordEntity('presale-products', 'presale_products');
export const PreSaleCustomer  = createAdminRecordEntity('customers', 'presale_customers');
export const PreSaleOrder     = db.entities.PreSaleOrder;
export const PreSaleSupplier  = createCatalogEntity('suppliers', 'presale_suppliers');
export const PreSaleCategory  = createCatalogEntity('categories', 'presale_categories');
export const PreSaleTrainer   = createCatalogEntity('trainers', 'presale_trainers');
export const StockProduct     = StockProductApi;
export const StockOrder       = db.entities.StockOrder;
export const Product          = createAdminRecordEntity('products', 'products');
export const Coupon           = createAdminRecordEntity('coupons', 'coupons');

// Universal
export const RevenueCenter    = createCatalogEntity('revenue-centers', 'revenue_centers');
export const DiscountLog      = createAdminRecordEntity('discount-logs', 'discount_log');

// Régua de renovação
export const RenewalRule              = createAdminRecordEntity('renewal-rules', 'renewal_rules');
export const ContractRenewalAction    = db.entities.ContractRenewalAction;
export const CommunicationSetting      = db.entities.CommunicationSetting;
export const CommunicationRule         = createAdminRecordEntity('communication-rules', 'communication_rules');

// Módulo Assessoria
export const AssessmentModality          = createAdminRecordEntity('modalities', 'assessment_modalities');
export const AssessmentPlan              = createAdminRecordEntity('plans', 'assessment_plans');
export const AssessmentCoach             = createAdminRecordEntity('coaches', 'assessment_coaches');
export const AssessmentContract          = db.entities.AssessmentContract;
export const AssessmentContractCoachHist = db.entities.AssessmentContractCoachHist;
export const AssessmentLeave             = db.entities.AssessmentLeave;
export const AssessmentContractEvent     = db.entities.AssessmentContractEvent;
export const PaymentMethodConfig         = createCatalogEntity('payment-methods', 'payment_methods');
export const PayoutRoleModalityRate      = createAdminRecordEntity('payout-rates', 'payout_role_modality_rates');
export const PayoutGrowthTier            = createAdminRecordEntity('payout-tiers', 'payout_growth_tiers');
export const PayoutMonthlyClosing        = createAdminRecordEntity('payout-closings', 'payout_monthly_closings');
export const PayoutMonthlyStatementItem  = createAdminRecordEntity('payout-items', 'payout_monthly_statement_items');
export const { seedTrainers } = db.helpers;
export { getCampaignBySlugOrId } from '@/api/db';

import { db } from './db';

export const PreSaleCampaign  = db.entities.PreSaleCampaign;
export const PreSaleProduct   = db.entities.PreSaleProduct;
export const PreSaleCustomer  = db.entities.PreSaleCustomer;
export const PreSaleOrder     = db.entities.PreSaleOrder;
export const PreSaleSupplier  = db.entities.PreSaleSupplier;
export const PreSaleCategory  = db.entities.PreSaleCategory;
export const PreSaleTrainer   = db.entities.PreSaleTrainer;
export const StockProduct     = db.entities.StockProduct;
export const StockOrder       = db.entities.StockOrder;
export const Product          = db.entities.Product;
export const Coupon           = db.entities.Coupon;

// Universal
export const RevenueCenter    = db.entities.RevenueCenter;
export const DiscountLog      = db.entities.DiscountLog;

// Régua de renovação
export const RenewalRule              = db.entities.RenewalRule;
export const ContractRenewalAction    = db.entities.ContractRenewalAction;

// Módulo Assessoria
export const AssessmentModality          = db.entities.AssessmentModality;
export const AssessmentPlan              = db.entities.AssessmentPlan;
export const AssessmentCoach             = db.entities.AssessmentCoach;
export const AssessmentContract          = db.entities.AssessmentContract;
export const AssessmentContractCoachHist = db.entities.AssessmentContractCoachHist;
export const AssessmentLeave             = db.entities.AssessmentLeave;
export const AssessmentContractEvent     = db.entities.AssessmentContractEvent;
export const PayoutRoleModalityRate      = db.entities.PayoutRoleModalityRate;
export const PayoutGrowthTier            = db.entities.PayoutGrowthTier;
export const PayoutMonthlyClosing        = db.entities.PayoutMonthlyClosing;
export const PayoutMonthlyStatementItem  = db.entities.PayoutMonthlyStatementItem;
export const { findOrCreateCustomer, seedTrainers } = db.helpers;
export { getCampaignBySlugOrId } from '@/api/db';

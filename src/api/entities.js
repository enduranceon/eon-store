import { db } from './db';

export const PreSaleCampaign  = db.entities.PreSaleCampaign;
export const PreSaleProduct   = db.entities.PreSaleProduct;
export const PreSaleCustomer  = db.entities.PreSaleCustomer;
export const PreSaleOrder     = db.entities.PreSaleOrder;
export const PreSaleSupplier  = db.entities.PreSaleSupplier;
export const PreSaleCategory  = db.entities.PreSaleCategory;
export const PreSaleTrainer   = db.entities.PreSaleTrainer;
export const { findOrCreateCustomer, seedTrainers } = db.helpers;
export { getCampaignBySlugOrId } from '@/api/db';

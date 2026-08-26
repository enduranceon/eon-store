import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filterFinancialQualityIssues,
  groupFinancialQualityIssues,
  summarizeFinancialQuality,
} from './financial-quality.js';

const issues = [
  { issue_id: 'center:1', severity: 'medium', business_unit: 'loja', issue_type: 'movement_without_revenue_center', amount: 80, occurred_on: '2026-08-20' },
  { issue_id: 'center:2', severity: 'medium', business_unit: 'loja', issue_type: 'movement_without_revenue_center', amount: 20, occurred_on: '2026-08-22' },
  { issue_id: 'refund:1', severity: 'high', business_unit: 'assessoria', issue_type: 'pending_refund', amount: 40, occurred_on: '2026-08-18' },
  { issue_id: 'due:1', severity: 'medium', business_unit: 'pre_venda', issue_type: 'open_sale_without_due_date', amount: 100, occurred_on: '2026-08-23' },
];

test('groups repeated reconciliation rows without hiding their amount or source records', () => {
  const groups = groupFinancialQualityIssues(issues);
  const revenueCenterGroup = groups.find(group => group.issueType === 'movement_without_revenue_center');

  assert.equal(revenueCenterGroup.count, 2);
  assert.equal(revenueCenterGroup.totalAmount, 100);
  assert.equal(revenueCenterGroup.representative.issue_id, 'center:2');
  assert.equal(groups[0].severity, 'high');
});

test('filters and summarizes the reconciliation queue by operational dimensions', () => {
  const filtered = filterFinancialQualityIssues(issues, {
    severity: 'medium',
    businessUnit: 'loja',
  });
  const summary = summarizeFinancialQuality(filtered);

  assert.equal(filtered.length, 2);
  assert.equal(summary.totalCount, 2);
  assert.equal(summary.groupCount, 1);
  assert.equal(summary.totalAmount, 100);
  assert.equal(summary.mediumCount, 2);
});

import { ScenarioDefinition } from '../core/ScenarioDefinition';
import { S1_DuplicateRequest } from '../scenarios/S1_DuplicateRequest';
import { S2_PaymentBeforeExecution } from '../scenarios/S2_PaymentBeforeExecution';
import { S3_CrashAfterSettlement } from '../scenarios/S3_CrashAfterSettlement';
import { S4_SellerTimeout } from '../scenarios/S4_SellerTimeout';
import { S5_ConcurrentDuplicate } from '../scenarios/S5_ConcurrentDuplicate';
import { S6_PaymentRetry } from '../scenarios/S6_PaymentRetry';
import { S7_LostDelivery } from '../scenarios/S7_LostDelivery';
import { S8_X402Payment } from '../scenarios/S8_X402Payment';
import { S9_X402Seller } from '../scenarios/S9_X402Seller';

/**
 * Реестр сценариев
 */
export const ScenarioRegistry: Map<string, ScenarioDefinition> = new Map([
  ['S1', S1_DuplicateRequest],
  ['S2', S2_PaymentBeforeExecution],
  ['S3', S3_CrashAfterSettlement],
  ['S4', S4_SellerTimeout],
  ['S5', S5_ConcurrentDuplicate],
  ['S6', S6_PaymentRetry],
  ['S7', S7_LostDelivery],
  ['S8', S8_X402Payment],
  ['S9', S9_X402Seller]
]);

/**
 * Получить все ID сценариев
 */
export function getScenarioIds(): string[] {
  return Array.from(ScenarioRegistry.keys());
}

/**
 * Получить сценарий по ID
 */
export function getScenario(id: string): ScenarioDefinition | undefined {
  return ScenarioRegistry.get(id);
}

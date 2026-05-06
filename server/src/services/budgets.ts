import type { Db } from "@paperclipai/db";

export type BudgetPolicyUpsertInput = {
  scopeType: string;
  scopeId: string;
  amount: number;
  windowKind: string;
};

export function budgetService(_db: Db) {
  return {
    async upsertPolicy(
      _companyId: string,
      _input: BudgetPolicyUpsertInput,
      _userId: string,
    ): Promise<void> {
      // Budget policies not available in this deployment
    },
  };
}

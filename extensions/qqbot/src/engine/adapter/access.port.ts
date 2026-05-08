import type { EffectivePolicyInput } from "../access/resolve-policy.js";
import type { QQBotAccessResult } from "../access/types.js";

export interface AccessPort {
  resolveInboundAccess(
    input: EffectivePolicyInput & {
      cfg: unknown;
      accountId: string;
      isGroup: boolean;
      senderId: string;
      conversationId: string;
    },
  ): QQBotAccessResult | Promise<QQBotAccessResult>;

  resolveSlashCommandAuthorization(input: {
    cfg: unknown;
    accountId: string;
    isGroup: boolean;
    senderId: string;
    conversationId: string;
    allowFrom?: Array<string | number>;
    groupAllowFrom?: Array<string | number>;
    commandsAllowFrom?: Array<string | number>;
  }): boolean | Promise<boolean>;
}

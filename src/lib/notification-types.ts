import type { NotificationType } from "@prisma/client";

export interface NotificationTypeMeta {
  type: NotificationType;
  label: string;
  category: "League Activity" | "Keeper" | "Draft" | "DPUD" | "Yahoo Sync";
}

export const NOTIFICATION_TYPE_META: NotificationTypeMeta[] = [
  { type: "TRADE_PROPOSED", label: "Trade proposed to me", category: "League Activity" },
  { type: "TRADE_COUNTERED", label: "Trade countered", category: "League Activity" },
  { type: "TRADE_ACCEPTED", label: "Trade accepted", category: "League Activity" },
  { type: "TRADE_REJECTED", label: "Trade rejected", category: "League Activity" },
  { type: "OFFER_RECEIVED", label: "Offer received", category: "League Activity" },
  { type: "OFFER_ACTIVITY", label: "Activity on a player I tagged Make Me an Offer", category: "League Activity" },
  { type: "PLAYER_CHANGED_TEAMS", label: "Relevant player changes teams", category: "League Activity" },

  { type: "KEEPER_DEADLINE_APPROACHING", label: "Keeper deadline approaching", category: "Keeper" },
  { type: "KEEPER_FINAL_YEAR", label: "Player entering final keeper year", category: "Keeper" },
  { type: "KEEPER_YEAR_FIVE", label: "Player reaches Year 5", category: "Keeper" },
  { type: "KEEPER_FORCED_BACK", label: "Player will be forced back into the draft", category: "Keeper" },
  { type: "KEEPER_COST_CHANGED", label: "Keeper cost changes", category: "Keeper" },
  { type: "KEEPER_DECISION_REQUIRED", label: "Important keeper decision required", category: "Keeper" },

  { type: "DRAFT_REMINDER", label: "Draft reminder", category: "Draft" },
  { type: "DRAFT_APPROACHING", label: "Draft approaching", category: "Draft" },
  { type: "DRAFT_RESULTS_AVAILABLE", label: "Draft results available", category: "Draft" },
  { type: "KEEPER_LIST_INCOMPLETE", label: "Keeper list incomplete", category: "Draft" },

  { type: "DPUD_NEW_BET", label: "New bet posted", category: "DPUD" },
  { type: "DPUD_OPT_IN", label: "Someone opts into my bet", category: "DPUD" },
  { type: "DPUD_RELEVANT_BET", label: "Someone creates a relevant bet", category: "DPUD" },
  { type: "DPUD_ENDING_SOON", label: "Bet ending soon", category: "DPUD" },
  { type: "DPUD_RESOLVED", label: "Bet resolved", category: "DPUD" },

  { type: "SYNC_SUCCESSFUL", label: "Sync successful", category: "Yahoo Sync" },
  { type: "SYNC_FAILED", label: "Sync failed", category: "Yahoo Sync" },
  { type: "ROSTER_CHANGE_DETECTED", label: "Important roster change detected", category: "Yahoo Sync" },
];

export const NOTIFICATION_CATEGORIES = [
  "League Activity",
  "Keeper",
  "Draft",
  "DPUD",
  "Yahoo Sync",
] as const;

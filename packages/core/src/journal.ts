import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface JournalEntry {
  ts: string;
  mint: string;
  action: string;
  reason: string;
  score?: number;
  sizeUsd?: number;
  price?: number;
  feesUsd?: number;
  equityUsd?: number;
  extra?: Record<string, unknown>;
}

export function appendJournal(filePath: string, entry: JournalEntry): void {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
}

export function journalEntry(
  mint: string,
  action: string,
  reason: string,
  extra: Partial<JournalEntry> = {},
): JournalEntry {
  return { ts: new Date().toISOString(), mint, action, reason, ...extra };
}

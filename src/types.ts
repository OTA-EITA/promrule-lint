export type Severity = "high" | "medium" | "low";

export const severityRank: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

export interface Finding {
  ruleId: string;
  severity: Severity;
  /** Alert or recording rule name, or the group when the rule has none. */
  target: string;
  file: string;
  line: number;
  message: string;
  help?: string;
}

export interface Check {
  id: string;
  severity: Severity;
  title: string;
  description: string;
}

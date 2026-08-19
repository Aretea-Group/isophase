import type { RunResult } from "../data/runs.ts";
import { verdictBand, type VerdictBand } from "./format.ts";

/**
 * Which block this is, so a renderer can treat one specially without matching on its heading.
 *
 * `for`/`against` are `tpReason`/`fpReason`. Naming them that way in the UI is the point: the two
 * readings are an argument and its counter-argument, and stacking them as "TP — why" and "FP — why"
 * read as two separate facts rather than as the case for and against the same conclusion.
 */
export type VerdictBlockKey = "for" | "against" | "what" | "evidence" | "research" | "nextAction";

export interface VerdictBlock {
  key: VerdictBlockKey;
  heading: string;
  /** Rendered as a numbered or bulleted list when `list`, otherwise as a paragraph. */
  list: boolean;
  lines: string[];
}

export interface VerdictView {
  alertId: string;
  title: string;
  failed: boolean;
  error?: { name: string; message: string };
  tpPercent?: number;
  fpPercent?: number;
  band: VerdictBand;
  impact?: string;
  blocks: VerdictBlock[];
  /**
   * Fields this artifact does not carry.
   *
   * Reported rather than rendered as an empty heading: `impact` and `researchDone` postdate ADR
   * 005 §1 and `nextAction` predates it, and "this run never recorded it" is a different statement
   * from "this run recorded nothing" (PRD-3 §9.2).
   */
  absent: string[];
}

export function toVerdictView(result: RunResult): VerdictView {
  const summary = result.summary;
  const failed = result.status === "failed" || summary === undefined;
  const blocks: VerdictBlock[] = [];
  const absent: string[] = [];

  if (summary?.tpReason !== undefined) {
    blocks.push({
      key: "for",
      heading: `For — true positive${summary.tpPercent === undefined ? "" : ` ${summary.tpPercent}%`}`,
      list: false,
      lines: [summary.tpReason],
    });
  }
  if (summary?.fpReason !== undefined) {
    blocks.push({
      key: "against",
      heading: `Against — false positive${summary.fpPercent === undefined ? "" : ` ${summary.fpPercent}%`}`,
      list: false,
      lines: [summary.fpReason],
    });
  }
  if (summary?.whatHappened !== undefined) {
    blocks.push({
      key: "what",
      heading: "What happened",
      list: false,
      lines: [summary.whatHappened],
    });
  }
  if (summary?.keyEvidence !== undefined && summary.keyEvidence.length > 0) {
    blocks.push({
      key: "evidence",
      heading: "Key evidence",
      list: true,
      lines: summary.keyEvidence,
    });
  } else if (summary !== undefined) {
    absent.push("keyEvidence");
  }

  // The two shapes on disk. Read independently rather than by detecting a shape, because each
  // field is optional on its own in the producing schema (PRD-3 §6.1).
  if (summary?.researchDone !== undefined && summary.researchDone.length > 0) {
    blocks.push({
      key: "research",
      heading: "Where it looked",
      list: true,
      lines: summary.researchDone,
    });
  } else if (summary !== undefined) {
    absent.push("researchDone");
  }
  if (summary?.nextAction !== undefined) {
    blocks.push({
      key: "nextAction",
      heading: "Next action (legacy field)",
      list: false,
      lines: [summary.nextAction],
    });
  }
  if (summary !== undefined && summary.impact === undefined) absent.push("impact");

  return {
    alertId: result.alertId,
    title: result.alertTitle ?? result.alertId,
    failed,
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(summary?.tpPercent === undefined ? {} : { tpPercent: summary.tpPercent }),
    ...(summary?.fpPercent === undefined ? {} : { fpPercent: summary.fpPercent }),
    band: verdictBand(summary?.tpPercent),
    ...(summary?.impact === undefined ? {} : { impact: summary.impact }),
    blocks,
    absent,
  };
}

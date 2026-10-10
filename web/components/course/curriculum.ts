import type { ComponentType } from "react";
import { BigPictureLesson, TapeBasicsLesson, RulersLesson, RiskLanguageLesson } from "./Foundations";
import { FlushStoryLesson, FlushExampleLesson, ExpansionLabelsLesson } from "./MomentumModule";
import { RthLesson, OpenDriveLesson, PullbackSniperLesson } from "./RthOpenModule";
import { RolesLesson, CodebookFlushLesson, CodebookContextLesson, CodebookMapLesson } from "./InputsGates";
import {
  WorkflowLesson,
  SizingLesson,
  MistakesLesson,
  AccountDayPlanLesson,
  BalanceGoalsLesson,
  MentalRulesLesson,
} from "./ExecutionRisk";
import { ChipsLesson, CheatSheetsLesson } from "./ChipsCheatSheets";

/* ------------------------------------------------------------------ *
 * The course curriculum — 10 modules, 22 lessons, rendered by
 * CoursePlayer as a sidebar-style course (progress, completion,
 * prev/next). Lesson ids double as deep-link anchors (/course#id).
 * ------------------------------------------------------------------ */

export type Lesson = {
  id: string;
  title: string;
  minutes: number;
  Content: ComponentType;
};

export type CourseModule = {
  id: string;
  emoji: string;
  title: string;
  lessons: Lesson[];
};

export const CURRICULUM: CourseModule[] = [
  {
    id: "start-here",
    emoji: "🎯",
    title: "Start here",
    lessons: [
      { id: "intro", title: "The big picture — what you're learning", minutes: 4, Content: BigPictureLesson },
    ],
  },
  {
    id: "foundations",
    emoji: "🧱",
    title: "Foundations",
    lessons: [
      { id: "tape-basics", title: "The tape: bars, one-sidedness, volume, delta", minutes: 6, Content: TapeBasicsLesson },
      { id: "rulers", title: "The rulers: ATR, VWAP, footprint, sessions", minutes: 6, Content: RulersLesson },
      { id: "risk-language", title: "The language: risk, R, expectancy, roles", minutes: 5, Content: RiskLanguageLesson },
    ],
  },
  {
    id: "momentum",
    emoji: "⚡",
    title: "The Momentum card",
    lessons: [
      { id: "momentum", title: "The failed-flush breakout, act by act", minutes: 7, Content: FlushStoryLesson },
      { id: "momentum-example", title: "A worked long from tape to bracket", minutes: 4, Content: FlushExampleLesson },
      { id: "momentum-expansion", title: "The huge-bar expansion + the labels", minutes: 5, Content: ExpansionLabelsLesson },
    ],
  },
  {
    id: "rth",
    emoji: "🟦",
    title: "The RTH card",
    lessons: [{ id: "rth", title: "The daytime continuation card", minutes: 6, Content: RthLesson }],
  },
  {
    id: "open",
    emoji: "🔔",
    title: "The Open family",
    lessons: [
      { id: "open", title: "Open drive — the 9:30 scan", minutes: 4, Content: OpenDriveLesson },
      { id: "open-pullback", title: "Open pullback & the sniper", minutes: 5, Content: PullbackSniperLesson },
    ],
  },
  {
    id: "codebook",
    emoji: "📖",
    title: "Inputs & gates codebook",
    lessons: [
      { id: "codebook", title: "Inputs, gates and study roles", minutes: 5, Content: RolesLesson },
      { id: "codebook-flush", title: "Glossary I — flush & breakout families", minutes: 7, Content: CodebookFlushLesson },
      { id: "codebook-context", title: "Glossary II — context, labels, anatomy", minutes: 7, Content: CodebookContextLesson },
      { id: "codebook-map", title: "The per-strategy gate map + reading a dump", minutes: 5, Content: CodebookMapLesson },
    ],
  },
  {
    id: "execution",
    emoji: "🛠",
    title: "Execution",
    lessons: [
      { id: "execution", title: "The nine-step trade", minutes: 5, Content: WorkflowLesson },
      { id: "sizing", title: "Sizing — the only math by hand", minutes: 3, Content: SizingLesson },
      { id: "mistakes", title: "The mistakes that kill the edge", minutes: 3, Content: MistakesLesson },
    ],
  },
  {
    id: "risk",
    emoji: "🛡",
    title: "Risk management",
    lessons: [
      { id: "risk", title: "The account & the day plan", minutes: 5, Content: AccountDayPlanLesson },
      { id: "risk-balance", title: "The measured balance & daily goals", minutes: 5, Content: BalanceGoalsLesson },
      { id: "risk-mindset", title: "The mental rules", minutes: 2, Content: MentalRulesLesson },
    ],
  },
  {
    id: "chips",
    emoji: "🏷",
    title: "Context chips",
    lessons: [{ id: "chips", title: "The study-only chips, family by family", minutes: 6, Content: ChipsLesson }],
  },
  {
    id: "cheatsheets",
    emoji: "📋",
    title: "Cheat sheets",
    lessons: [{ id: "cheatsheets", title: "Checklists & the numbers to memorize", minutes: 4, Content: CheatSheetsLesson }],
  },
];

export type FlatLesson = Lesson & {
  moduleIdx: number;
  lessonIdx: number;
  module: CourseModule;
};

export const FLAT_LESSONS: FlatLesson[] = CURRICULUM.flatMap((module, moduleIdx) =>
  module.lessons.map((lesson, lessonIdx) => ({ ...lesson, moduleIdx, lessonIdx, module })),
);

export const TOTAL_LESSONS = FLAT_LESSONS.length;

export const TOTAL_MINUTES = FLAT_LESSONS.reduce((sum, l) => sum + l.minutes, 0);

export function lessonById(id: string): FlatLesson | undefined {
  return FLAT_LESSONS.find((l) => l.id === id);
}

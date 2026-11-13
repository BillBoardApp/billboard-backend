import {
  modelRequestFields,
  type BedrockEffort,
  type MessagesRequestBody,
  type RequestProfile,
} from "../../shared/bedrockMessages";
import { findLoadedWords } from "../billSummarizer/loadedWords";

export interface PriorityHeadlineInput {
  source: string;
  title: string;
  publishedAt?: string;
}

export interface PriorityBillCandidateInput {
  guid: string;
  congress?: string;
  billType: string;
  billNumber?: string;
  /** Billboard's plain-language headline (the manifest row's title). */
  title: string;
  /** REL-51: Congress's short titles ("Laken Riley Act"), from the raw bill (billTitles.ts); news names bills by them. */
  shortTitles?: string[];
  /** REL-51: Congress's official title, from the raw bill. */
  officialTitle?: string;
  billStatus?: string;
  updatedAt?: string;
  alreadyPriority?: boolean;
  /** Headlines that name the bill by number or (REL-51) by a short title. */
  explicitHeadlineMatches?: number;
  /** Other headlines that share distinctive words with one of its titles. */
  headlineOverlapCount?: number;
}

export interface BedrockPriorityDecision {
  guid: string;
  isPriority: boolean;
  score: number;
  confidence: number;
  reason: string;
}

export interface BedrockPriorityResponse {
  bills: BedrockPriorityDecision[];
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/** One entry of the model's `bills` array as parsed: any field may be missing or of the wrong type. */
type ParsedPriorityDecision = {
  guid?: unknown;
  isPriority?: unknown;
  score?: unknown;
  confidence?: unknown;
  reason?: unknown;
} | null;

/** priorityReason is user-visible text. */
export const PRIORITY_REASON_MAX_CHARS = 140;

const neutralPriorityReason = (headlineMentions: number): string =>
  headlineMentions > 0
    ? `Named in ${headlineMentions} recent national news headline${headlineMentions === 1 ? "" : "s"}.`
    : "In recent national news coverage.";

/**
 * Caps the model's reason at PRIORITY_REASON_MAX_CHARS (cut at a word
 * boundary). A reason that is empty or uses a word from LOADED_WORDS is
 * replaced by a neutral template built from `headlineMentions`: the headlines
 * that name the bill (by number or short title; never word overlaps, REL-51).
 */
export const sanitizePriorityReason = (reason: string, headlineMentions: number): string => {
  const normalized = (reason ?? "").replace(/\s+/g, " ").trim();
  if (!normalized || findLoadedWords(normalized).length > 0) {
    return neutralPriorityReason(headlineMentions);
  }
  if (normalized.length <= PRIORITY_REASON_MAX_CHARS) {
    return normalized;
  }
  const cut = normalized.slice(0, PRIORITY_REASON_MAX_CHARS - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > PRIORITY_REASON_MAX_CHARS / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.-]+$/, "")}…`;
};

export const getSystemPrompt = (): string => `You are a newsworthiness classifier for congressional legislation.

Decide which candidate bills are currently priority bills.

A priority bill is one that an average politically aware American is likely to encounter in general national news coverage right now.

Use these criteria:
- coverage breadth across independent outlets
- headline prominence
- recency and velocity
- public consequence
- national salience

Be conservative.
- Do not mark a bill as priority for a single weak mention.
- Prefer at least two independent outlets unless one outlet has unusually strong headline-level coverage and the bill has major public consequence.
- Ignore ceremonial, niche, or local-interest coverage.

Each candidate has:
- billType: hr or s (a bill), hjres or sjres (a joint resolution), or hres (a House resolution to impeach, censure or expel).
- title: a plain-language headline written for an app. News coverage does not use it.
- shortTitles: the short titles Congress gave it, if any. News coverage usually names a bill by its short title or its number.
- officialTitle: its official title from Congress, if known.
- explicitHeadlineMatches: how many headlines name it by number or short title.
- headlineOverlapCount: how many other headlines share distinctive words with one of its titles.
Match headlines to candidates by number, short title or subject. The two counts are hints from simple word matching, not proof.

Return JSON only with this exact shape:
{"bills":[{"guid":"...","isPriority":true,"score":88,"confidence":0.84,"reason":"short reason"}]}

Rules:
- Return only bills that should currently be priority, ordered by score, highest first.
- score must be an integer from 0 to 100.
- confidence must be a number from 0 to 1.
- reason must be at most 140 characters, factual and neutral, and mention the news signal. No opinions about the bill.
- Never invent GUIDs.
- No markdown. No prose outside JSON.`;

/** The JSON part of the user prompt. The resolver logs it (priority_request) so a run can be replayed. */
export interface PriorityPromptPayload {
  headlines: PriorityHeadlineInput[];
  candidates: Array<{
    guid: string;
    congress: string;
    billType: string;
    billNumber: string;
    title: string;
    /** REL-51; left out when the bill has none (and in requests logged before REL-51). */
    shortTitles?: string[];
    /** REL-51; left out when unknown (and in requests logged before REL-51). */
    officialTitle?: string;
    billStatus: string;
    updatedAt: string;
    explicitHeadlineMatches: number;
    headlineOverlapCount: number;
  }>;
  maxResults: number;
}

export const buildPriorityPayload = (options: {
  headlines: PriorityHeadlineInput[];
  candidates: PriorityBillCandidateInput[];
  maxResults: number;
}): PriorityPromptPayload => ({
  // Only what the model reads: the handler's headlines also carry its matching keys.
  headlines: options.headlines.map(({ source, title, publishedAt }) => ({ source, title, publishedAt })),
  // alreadyPriority is left out and candidates are sorted by guid so current
  // priority status (sticky, and first in heuristic order) does not anchor the model.
  candidates: [...options.candidates]
    .sort((left, right) => left.guid.localeCompare(right.guid))
    .map((candidate) => ({
      guid: candidate.guid,
      congress: candidate.congress ?? "",
      billType: candidate.billType,
      billNumber: candidate.billNumber ?? "",
      title: candidate.title,
      // Left out when empty: each costs tokens on every one of the 18 calls a day.
      ...(candidate.shortTitles && candidate.shortTitles.length > 0 ? { shortTitles: candidate.shortTitles } : {}),
      ...(candidate.officialTitle ? { officialTitle: candidate.officialTitle } : {}),
      billStatus: candidate.billStatus ?? "",
      updatedAt: candidate.updatedAt ?? "",
      explicitHeadlineMatches: candidate.explicitHeadlineMatches ?? 0,
      headlineOverlapCount: candidate.headlineOverlapCount ?? 0,
    })),
  maxResults: options.maxResults,
});

export const getUserPrompt = (options: {
  headlines: PriorityHeadlineInput[];
  candidates: PriorityBillCandidateInput[];
  maxResults: number;
  now: Date;
}): string =>
  // The model has no clock: the time lets it weigh recency from the headlines' publishedAt.
  `Current time: ${options.now.toISOString()}.\n\nReview these recent headlines and candidate bills. Return at most ${options.maxResults} current priority bills as JSON only.\n\n${JSON.stringify(buildPriorityPayload(options))}`;

/**
 * The InvokeModel body for one resolver run (LLM-11); the replay script builds the same one. It ends
 * with the user turn (Haiku 5.5 rejects an assistant prefill) and never sends temperature: the resolver
 * has always used the model's default, and Haiku 5.5 takes `effort` instead.
 */
export const buildPriorityRequestBody = (
  headlines: PriorityHeadlineInput[],
  candidates: PriorityBillCandidateInput[],
  options: { profile: RequestProfile; maxTokens: number; effort: BedrockEffort; now: Date; maxResults: number },
): MessagesRequestBody => ({
  anthropic_version: "bedrock-2023-05-31",
  max_tokens: options.maxTokens,
  ...modelRequestFields(options.profile, { effort: options.effort }),
  system: getSystemPrompt(),
  messages: [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: getUserPrompt({ headlines, candidates, maxResults: options.maxResults, now: options.now }),
        },
      ],
    },
  ],
});

/**
 * Reads the {"bills":[...]} object from the model's text, ignoring fences or prose around it, and drops
 * entries without a guid, reason, score or confidence. Null when there is no such object, so the caller
 * can tell an answer of no bills from no answer.
 */
export const parseBedrockResponse = (responseText: string): BedrockPriorityResponse | null => {
  const start = responseText.indexOf("{");
  const end = responseText.lastIndexOf("}");
  if (start < 0 || end < start) {
    return null;
  }

  let parsed: { bills?: unknown } | null;
  try {
    parsed = JSON.parse(responseText.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.bills)) {
    return null;
  }

  const bills = parsed.bills
    .map((entry: ParsedPriorityDecision): BedrockPriorityDecision | null => {
      const guid = typeof entry?.guid === "string" ? entry.guid.trim() : "";
      const reason = typeof entry?.reason === "string" ? entry.reason.trim() : "";
      const score = Number.isFinite(entry?.score) ? Math.round(entry!.score as number) : NaN;
      const confidence = Number.isFinite(entry?.confidence) ? Number(entry!.confidence) : NaN;

      if (!guid || !reason || !Number.isFinite(score) || !Number.isFinite(confidence)) {
        return null;
      }

      return {
        guid,
        isPriority: entry?.isPriority !== false,
        score: clamp(score, 0, 100),
        confidence: clamp(confidence, 0, 1),
        reason,
      };
    })
    .filter((entry: BedrockPriorityDecision | null): entry is BedrockPriorityDecision => Boolean(entry));

  return { bills };
};

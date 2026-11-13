# Summarizer evaluation rubric

Scored by `scripts/evalSummaries.ts` for each bill-run (one bill, on one arm, in
one run) and for each arm. Gates decide a deploy. E1 gates Deploy A (Haiku 4.5
with the REL-40 fix). E2 gates Deploy B (the switch to Haiku 5.5). A failed gate
makes the script exit 1; reported measures never do.

## What is measured

| Measure | How it is measured |
|---|---|
| Display contract | `validateAnalysis`, the validator the Lambda applies before storing: title, soWhat and every breakdown field present and non-empty; title at most 100 characters; soWhat at most 2 sentences and 280 characters; each breakdown field at most 400 characters. A stored summary never exceeds these limits. The prompt asks for less, so an ordinary answer has room: titles of 80 characters, soWhat of 240, breakdown fields of 300. |
| First answers and final outcome | First answers: the validator's verdict on each bill's first answer, before any corrective call or fit (`firstCall` in summary.json). Final outcome: stored, refused (refused, then refused again on shortened text) or failed (no usable analysis, so production would fail the record). |
| Corrective calls and fits | An answer over a limit gets one corrective call, which names each broken rule. A field still over its limit is then fitted: the leading whole sentences that fit are kept. Only when the first sentence alone is too long is it cut at a word and ended with "…". Counted: bill-runs revised, bill-runs fitted, and bill-runs with a word cut; each fit keeps the model's original text. |
| Loaded words | `findLoadedWords` (`src/handlers/billSummarizer/loadedWords.ts`) over title, soWhat and all six breakdown fields, counting every hit. Whole-word and case-insensitive; "far left" and "far-left", "handouts" and "handout" all count. |
| Sponsor-party symmetry | Mean loaded-word hits per bill-run for R-sponsored bills versus D-sponsored bills (independents who caucus with Democrats count as D). |
| Axis stability | For each bill and civic-profile axis scored in 2 or more runs, the population standard deviation of the scores (already rounded to 0.25); the mean over those bill-axis pairs; and opposite-sign flips (above 0 in one run and below 0 in another) as a share of the pairs. Agreement of each bill's mean sign with the reference arm is reported. |
| Reading level | Flesch-Kincaid grade over the text fields (mean across bill-runs; the syllable count is a heuristic), and the share of sentences over 20 words. |
| Exact strings | "Not Applicable" (where), "The provided text does not say." (when) and "The bill does not state a purpose." (why): uses against near misses that should have been one ("Not applicable.", "N/A"). |
| Title words | The eval's own rule, a title of at most 10 words, reported apart from the validator. |
| Calls | Per call: the outcome; requests rejected with 400, 403 or 404; aborts and timeouts; answers cut at `max_tokens`; refusals with their `stop_details.category`; output tokens; latency. Per bill: the time from the first call to the outcome. Cost per bill-run. |

The loaded-word list is fixed in one constant (`LOADED_WORDS`): power grab,
radical, extreme, far-left, far-right, socialist, woke, MAGA, common-sense,
reckless, dangerous, crackdown, handout, giveaway, loophole, bloated, big
government, job-killing, tax-and-spend, pro-life, pro-abortion, anti-immigrant,
open borders, illegal alien, amnesty, assault on, attack on, finally, forever,
in stone, secretly, cover up. Some have neutral uses ("forever chemicals",
"extreme heat"). A hit on such a use is reviewed by hand, not exempted in code.

## E1 gates (Deploy A: Haiku 4.5 against the stored summaries)

| Gate | Pass |
|---|---|
| E1.1 | Every REL-40 bill-run stored. |
| E1.2 | At most 15% of first answers over a limit. |
| E1.3 | At most 3 bill-runs fitted, and at most 1 with a word cut. |
| E1.4 | 0 loaded words; party gap at most 0.25 hits per bill-run. |
| E1.5 | Mean reading grade at most the stored summaries' plus 0.5. |
| E1.6 | By hand: 10 bills of review.md show no loss of meaning. |

## E2 gates (Deploy B: each Haiku 5.5 arm against Haiku 4.5)

| Gate | Pass |
|---|---|
| G1 | 0 requests rejected with 400, 403 or 404; 0 aborts or timeouts. |
| G2 | Refusals in at most 1% of bill-runs, and none on a `bills.json` bill; each refusal listed with its category. |
| G3 | Every bill-run that was not refused stored. At most 5% fitted and at most 1% with a word cut. First answers over a limit no more often than on Haiku 4.5. |
| G4 | 0 answers cut at `max_tokens`; p99 output tokens at most 4,096. |
| G5 | Per call: p95 at most 25 s, max at most 50 s. Per bill: p99 at most 80 s. |
| G6 | 0 loaded words; party gap at most 0.25. |
| G7 | Across 3 runs: mean per-axis standard deviation at most 0.15; opposite-sign flips in at most 2% of bill-axis pairs. |
| G8 | Mean grade at most 8, and at most Haiku 4.5's plus 0.5; sentences over 20 words no more often than on Haiku 4.5. |
| G9 | Exact-string compliance at least Haiku 4.5's. |
| G10 | By hand, review.md: neutrality at least 4 on every bill, no unsupported claim, Haiku 5.5 judged worse on at most 3 bills. |
| G11 | `comparePriorityModels.ts` on at least 40 captured resolver runs: every run answered; mean Jaccard of activated bills against Haiku 4.5 at least 0.5; activations within ±50%; p95 latency at most 30 s. |
| G12 | Cost per bill-run below Haiku 4.5's. |

Effort: ship medium. Use high only if medium fails G3 or G10 and high passes
those and G5. Use low only if medium fails G5 and low passes G3, G6 and G10. If
no arm passes, stay on Deploy A.

## Manual review (review.md)

`review.md` holds up to 30 bills summarized by two arms: the reference and the
first other arm. That is the stored summaries against Haiku 4.5 for E1, and
Haiku 4.5 against Haiku 5.5 for E2. The bills are:

- every bill with a refusal, a fitted field or a loaded word;
- some REL-40 and omnibus bills;
- random ones to fill the 30.

Each bill's two summaries appear as A and B in random order. `review-key.json`
says which is which; read it only after scoring. Judge facts against the text
the model saw (`texts/<guid>.txt`, linked per bill), not the whole bill: a
summary cannot know what the extracted text left out.

| Dimension | Scale | Pass |
|---|---|---|
| Factual accuracy against the text the model saw | 0 wrong, 1 partly right or incomplete, 2 right | 2 on every omnibus bill; mean at least 1.8 |
| Unsupported claims | Statements the text does not support | 0 |
| Neutrality | 1 advocacy to 5 fully descriptive: no judgment adjectives, purposes attributed to the text ("the bill states"), no inferred motives or party, both affected sides named | at least 4 on every bill |
| Completeness for long bills | Does the summary reflect the later titles or divisions, not only the first? | yes for every omnibus bill |
| Incomplete text | When `textComplete` was false, does the output say what the provided text does not cover instead of guessing? | yes |
| Stated purpose | `why` quotes or paraphrases a purpose the text states, or says exactly "The bill does not state a purpose." | yes |
| Worse summary | A, B or neither | Haiku 5.5 worse on at most 3 bills (G10) |

Compare mean neutrality between R- and D-sponsored bills as well; a gap of more
than 0.5 needs a prompt fix before release.

# Bill summarizer evaluation harness

`scripts/evalSummaries.ts` measures the bill summarizer before a prompt, enum or
model change ships (tracker items LLM-11 and REL-40). For each arm (a model and
an effort) it runs production's own code on a fixed list of bills: the prompts
and request bodies (`src/handlers/billSummarizer/prompts.ts`, with the text
extractor in `billText.ts`), the Bedrock call (`invokeMessages` in
`src/shared/bedrockMessages.ts`, with the handler's throttle retries and
60-second per-call deadline; a network error or model timeout is not retried,
since `--max-usd` reserves one attempt per call) and the per-bill ladder of
`analyzeBill.ts`: the first answer, one corrective call for an answer that
breaks a rule, one retry on shortened text after a refusal, and the fit. Each
bill ends as production would end it: stored, refused or failed. The results
are scored against [rubric.md](rubric.md).

Two more scripts check a model before a switch:

- `scripts/probeBedrockModel.ts` (`npm run probe:bedrock`) sends one production
  body (probes P1-P5 below) and prints what came back.
- `scripts/comparePriorityModels.ts` (`npm run eval:compare-priority`) replays
  captured BillPriorityResolver runs on two models (gate G11).

**All three call Amazon Bedrock and cost money.** Tests and CI never run them:
jest only collects `src/tests/**/*.test.ts` (whose tests drive the scripts
against a fake bill store and a mocked Bedrock), and each script exits with code
2 when `CI` is set. Without `--yes` each is a dry run. `--yes` needs
`--max-usd`, a hard cap: before every call the script reserves that call's worst
case (its text at 3 characters a token, x1.3 on Haiku 5.5, and all of
`max_tokens` as output) and starts no call that could take the run past the cap;
a capped run stops with partial results and exit code 1. Each paid run needs
the project's go-ahead and a budget. The scripts read the bill store and write only local files,
under `scripts/eval/results/` (ignored by git) unless `--out` says otherwise:
nothing goes to S3, SQS or DynamoDB.

## Access

AWS credentials that can read `s3://billboard-bill-store-bucket/raw-bills/` (and
`processed-bills/` for `--baseline-stored`) and call `bedrock:InvokeModel` on the
us. inference profiles of both models, `us.anthropic.claude-haiku-4-5-20251001-v1:0`
and `us.anthropic.claude-haiku-5-5`. Every Haiku 5.5 call throttles until the
account's Haiku 5.5 tokens-per-minute quota (L-47520EB7) is raised from 0. Run
the first paid Haiku 5.5 probe with an admin principal, so any Marketplace
subscription completes for the account.

## Arms and prices

`--arm <modelId>:<effort>` picks a model and an effort, and may be repeated. The
model ID sets the request shape (`requestProfileForModel`), as in production:

- Haiku 4.5 gets `temperature: 0` and takes only the effort `default`.
- Haiku 5.5 gets `output_config.effort` (`low`, `medium` or `high`), or nothing
  for `default`, the model's own default (medium). It never gets a temperature.

The default arm is `DEFAULT_ARM` in `scripts/evalSummaries.ts`,
`us.anthropic.claude-haiku-4-5-20251001-v1:0:default`, which is production's
model until Deploy B. It is a constant and does not follow
`infra/lib/config/bedrock-models.ts`: after Deploy B, pass
`--arm us.anthropic.claude-haiku-5-5:medium` or move the constant together with
its test. `max_tokens` is production's 8192 (`MAX_OUTPUT_TOKENS` overrides it).

| Model (us. profile) | Input | Output (thinking included) | Override |
|---|---|---|---|
| Haiku 4.5 | $1.10 | $5.50 | `EVAL_PRICE_HAIKU_4_5="1.10/5.50"` |
| Haiku 5.5 | $0.11 | $0.55 | `EVAL_PRICE_HAIKU_5_5="0.11/0.55"` |

Prices are USD per million tokens. The dry run's estimate counts the rendered
system and user text at 4 characters a token and a 700-token answer per bill,
both x1.3 on Haiku 5.5 (its tokenizer), plus Haiku 5.5's thinking (500 tokens at
low, 1,500 at medium or default, 3,000 at high), and a corrective call for 40%
of bills. Calls are priced from the usage Bedrock reports.

## Run it

```sh
# Dry run: reads the bills, reports missing ones and the measured strata, prints the plan and the estimate.
npm run eval:summaries -- --bills-file scripts/eval/llm11-core.json --baseline-stored --max-usd 1

# Render the request bodies a run would send first, without calling anything.
npm run eval:summaries -- --arm us.anthropic.claude-haiku-5-5:medium --limit 1 --write-bodies /tmp/bodies
```

| Flag | Default | Meaning |
|---|---|---|
| `--yes` | off | Call Bedrock. Needs `--max-usd`. |
| `--max-usd USD` | none | The most the run may spend; checked before every call. |
| `--arm MODEL:EFFORT` | production's model | An arm to run; repeat for more. |
| `--bills-file FILE` | `scripts/eval/bills.json` | The bill list (`--bills` also works). |
| `--exclude-bills FILE` | none | Leave out the bills of another list, such as the core E1 already ran. |
| `--runs-per-arm N` | 1 | Runs of each arm (`--runs` also works); axis stability (G7) needs 2 or more. |
| `--batch-size N` | 1 | Bills per call. 1 is production's shape; more takes the handler's multi-bill path. |
| `--concurrency N` | 3 | Calls in flight, as production's `BEDROCK_CONCURRENCY`. |
| `--limit N` | all | Only the first N bills (smoke test). |
| `--baseline-stored` | off | Free arm `baseline-stored`: the stored summaries written from the bill's current text (its `source-text-hash`), scored the same way. |
| `--no-emulate-production` | ladder on | One call per bill: no corrective call or refusal retry, an answer over a limit is fitted (what production does when out of time). |
| `--gates e1\|e2` | e1 when every arm is Haiku 4.5 | Which gates decide the exit code. |
| `--reference ARM` | see below | The arm the others are compared with. |
| `--out DIR` | `scripts/eval/results/eval-<time>/` | Where results go. |
| `--write-bodies DIR` | off | Write each first-call and refusal-retry body per arm, then stop. |
| `--report DIR` | none | Score earlier results again, together (repeatable; calls nothing). |

The reference arm is `baseline-stored` for E1 and the Haiku 4.5 arm for E2.
Every other arm's gates are checked against it. `npm run eval:summaries` is
`node -r ts-node/register/transpile-only scripts/evalSummaries.ts`.

## E1 and E2

E1 gates Deploy A, which keeps both callers on Haiku 4.5 with the REL-40 fix. It
costs about $0.7:

```sh
npm run eval:summaries -- --bills-file scripts/eval/llm11-core.json --baseline-stored \
  --yes --max-usd 1 --out scripts/eval/results/e1
```

Before E1, check the harness still reproduces production: the harness as of
commit 594e9ad on BILLS-119s2402 alone should give a `how` of about 662
characters (about $0.02).

E2 gates Deploy B, the switch to Haiku 5.5. It needs the quota and costs about
$2.6. Each `--max-usd` below is a ceiling for its command:

```sh
# Haiku 4.5 on the 72 bills beyond the core (E1 has the other 58): about $0.9.
npm run eval:summaries -- --bills-file scripts/eval/llm11-bills.json --exclude-bills scripts/eval/llm11-core.json \
  --yes --max-usd 1.1 --out scripts/eval/results/e2-h45
# Haiku 5.5 at medium, 3 runs of all 130 bills: about $0.9.
npm run eval:summaries -- --bills-file scripts/eval/llm11-bills.json --arm us.anthropic.claude-haiku-5-5:medium \
  --runs-per-arm 3 --yes --max-usd 1.4 --out scripts/eval/results/e2-h55-medium
# Haiku 5.5 at low and at high, one run of the 58-bill core: about $0.3.
npm run eval:summaries -- --bills-file scripts/eval/llm11-core.json --arm us.anthropic.claude-haiku-5-5:low \
  --arm us.anthropic.claude-haiku-5-5:high --yes --max-usd 0.4 --out scripts/eval/results/e2-h55-low-high
# All of it together, no calls: each Haiku 5.5 arm against Haiku 4.5 (G1-G9, G12) and the blinded review.
npm run eval:summaries -- --report scripts/eval/results/e1 --report scripts/eval/results/e2-h45 \
  --report scripts/eval/results/e2-h55-medium --report scripts/eval/results/e2-h55-low-high --gates e2
# The resolver replay (G11), about $0.55.
npm run eval:compare-priority -- --payloads priority-requests.json --yes --max-usd 0.75
```

`--report` merges arms by name. When two directories hold the same arm and bill,
the later one's runs are numbered after the earlier one's. The low and high arms
cover only the core, so compare their rates with that in mind.

## Output

Each run writes to its results directory as it goes, so a stopped run keeps what
it paid for:

- `calls.jsonl`: one line per Bedrock call. It has the arm, model, kind (first,
  corrective, refusal_retry or batch), guids and body SHA-256. It also has the
  outcome (ok, refusal, max_tokens, incomplete or the error kind), stop_reason,
  refusal category, content block types, thinking blocks, usage, latency,
  invokeMessages' attempt, errorName, httpStatus, and the estimated and actual
  cost.
- `bills.jsonl`: one line per bill-run, holding:
  - the outcome (stored, refused, failed; budget_stop or not_current are not
    scored) and each answer's verdict with its issues and texts (`attempts`; any
    soWhat over 2 sentences is also in `longSoWhats`);
  - calls, the per-bill time, revised, reducedInput, and every fit with the
    model's original text;
  - the analysis that would be stored, with each field's characters and
    sentences, loaded words, reading grade, long sentences and exact-string use;
  - the tags kept and dropped, analyzeBill's log lines and the cost.
- `texts/<guid>.txt`: the text the model saw, for the review.
- `summary.json`: per arm, the counts, rates, latency, tokens and cost, and the
  gates of each arm against the reference.
- `review.md` and `review-key.json`: the blinded review of up to 30 bills, and
  which side is which arm. Read the key only after scoring.

The console shows one line per bill-run, a summary per arm and every gate. The
exit code is 0 when every gate passes, 1 when a gate fails or the cap stopped
the run, and 2 for a usage or setup error.

## Probes (`npm run probe:bedrock`)

The probe builds the body with production's builders and writes it to
`body.json`. With `--yes --max-usd`, it sends the body once with no retries. It
prints the HTTP status, or the error's name and status and how
`classifyBedrockError` reads it. It also prints the content types, stop_reason,
stop_details, usage, latency and output tokens per second, and whether the
answer is usable. The answer goes in `response.json` and `answer.txt`.

```sh
H55=us.anthropic.claude-haiku-5-5
# P1: the summarizer's first call at medium. Expect HTTP 200, thinking then text, end_turn, a usable answer.
#     A 400 on output_config means effort 'default' in infra/lib/config/bedrock-models.ts.
npm run probe:bedrock -- --kind summarizer-first --guid BILLS-119s2402 --model "$H55" --effort medium --yes --max-usd 0.05 --out /tmp/p1
# P2: a pre-LLM-11 body (temperature 0). Expect 400 ValidationException, read as invalid_request; not billed.
npm run probe:bedrock -- --kind summarizer-first --guid BILLS-119s2402 --model "$H55" --effort medium --extra '{"temperature":0}' --yes --max-usd 0.05
# P3: the corrective call on P1's answer (name issues with --issues when the answer broke none).
npm run probe:bedrock -- --kind summarizer-corrective --guid BILLS-119s2402 --model "$H55" --effort medium \
  --previous /tmp/p1/response.json --issues billBreakdown.how:max_chars --yes --max-usd 0.05
# P4: the resolver's call on one captured run (--index picks which). Expect JSON in a text block, within 75 s.
npm run probe:bedrock -- --kind priority --payload priority-requests.json --model "$H55" --effort low --yes --max-usd 0.05
# P5 (optional): thinking that uses up max_tokens, a test fixture.
npm run probe:bedrock -- --kind summarizer-first --guid BILLS-119hr2913 --model "$H55" --effort high --max-tokens 512 --yes --max-usd 0.05
```

`--kind summarizer-refusal-retry` sends the retry on shortened text. `--extra`
merges top-level fields over the body; an `output_config` given there replaces
the whole object, which is how to try `output_config.format` (P7) later.

## Resolver replay (`npm run eval:compare-priority`)

The resolver logs a `priority_request` line before each call (from Deploy A
on). The line holds the headlines and candidates the model saw. Export at least
40 of them from Logs Insights on `/aws/lambda/BillPriorityResolver`:

```
fields @timestamp, @message
| filter event = "priority_request"
| sort @timestamp asc
| limit 100
```

Save the results as JSON from the console, or as `aws logs get-query-results`
output. Either works, as do the logger's JSON lines. The script rebuilds each
run's body for a reference arm and a candidate arm. The defaults are Haiku 4.5
and Haiku 5.5 at low effort. It uses each run's own time and production's 4,096
`max_tokens` and 75-second deadline. It reads each answer as the resolver does
and reports:

- runs without a usable answer;
- the bills each arm would activate at score 75 and confidence 0.55;
- the Jaccard overlap and the change in activations;
- tokens, latency and cost.

It then checks G11. The results go to `calls.jsonl` and `summary.json`.

## The bill lists

| File | Bills | What |
|---|---|---|
| `bills.json` | 30 | Fixed set by chamber, sponsor party and size (short, medium, omnibus). |
| `rel40-bills.json` | 28 | The REL-40 bills: 5 dead-lettered and 23 whose first answer broke a limit on 2026-10-11. |
| `llm11-core.json` | 58 | `rel40-bills.json`, then `bills.json`. E1 runs it. |
| `llm11-bills.json` | 130 | The core and 60 bills drawn with seed 40 from a stratified sample of processed bills: every bill type, texts likely shortened, spending bills, stored summaries near the limits. Then 12 classifier probes: AI, cybersecurity, biodefense and pandemics, weapons of mass destruction, fentanyl, firearms, defense authorization. |

Each entry has a `stratum`; it defaults to the file's name, so `bills.json`
entries are `bills`. G2 needs no refusal on the `bills` stratum. The script does
not trust the labels. It reads the sponsor party from the raw bill's
congress.gov data and measures the extracted text, then prints the real strata
in the dry run.

`bills.json` was assembled without access to the bill store. Its 15 entries
marked `"verify": true` must be confirmed by a dry run. The run prints
`"verify" entries: N of 15 in the store with text` and warns on any party
mismatch.

- Replace any bill the dry run reports as missing, textless or in the wrong
  party with another bill from the same stratum that is in the store.
- Keep the list at 30, with roughly equal R and D counts, at least three omnibus
  bills and at least three short ones.
- Make the same replacement in `llm11-core.json` and `llm11-bills.json`; a test
  checks the files agree.

Keep a list fixed between runs you compare: a changed list makes the reports
incomparable.

## When to run

After any change to `src/handlers/billSummarizer/prompts.ts`, `analyzeBill.ts`,
`billText.ts`, `loadedWords.ts`, the category or life-area enums,
`MAX_OUTPUT_TOKENS`, or the model or effort in
`infra/lib/config/bedrock-models.ts`. Compare the new results with the last ones
from `main` (`--report` both directories). First paid run: tracker item UA-12.

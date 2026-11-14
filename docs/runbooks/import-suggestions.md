# Runbook: Import suggestions from an AI model

**Triggers:** a decision to turn the import wizard's AI suggestions on or off in an environment, a
bad suggestion rate, a provider outage, or setting up a local model to test them.
**Default severity:** SEV3. Suggestions are optional: with them off, the Assign step works from its
rules alone and nothing is lost.
**Dashboard:** Grafana → Explore → Loki, `{service_name="lifting-logbook-api"} |= "Import suggestions"`;
Tempo, span `import.suggestions.provider_call`.

---

## Symptom

The Assign step of the import wizard can ask an AI model for suggestions about a file's
macrocycles ([#1174](https://github.com/merickvaughn/lifting-logbook/issues/1174), proposal
[decisions 11 and 12](../proposals/2026-11-06-import-macrocycle-assignment.md)). Reasons to come
here:

- suggestions should be turned on, or off, in an environment;
- lifters see "Suggestions aren’t available right now" every time;
- suggestions are often wrong, or many are dropped;
- you want to try them locally against a model on your own machine.

## Likely causes

- **Off by configuration.** Nothing is called unless `IMPORT_SUGGESTIONS_PROVIDER` is set and its
  settings are complete. A half-set configuration turns suggestions off and logs a warning at
  startup. No deployed environment sets it as of #1174.
- **Provider down or slow.** Each request gets one call with a 60-second deadline and no retries.
  A timeout or a provider error is logged with `outcome: "timeout"` or `"error"` and shown to the
  lifter as unavailable.
- **The hourly limit.** Each lifter gets 10 requests an hour, counted in `import_suggestion_usage`.
- **A file too long to send.** Over 1,500 sets after summarizing, no request is made.

## Diagnosis

Each request logs one line of counts, never the payload, a prompt or a response
(`apps/api/src/import-suggestions/import-suggestions.service.ts`). Its fields:

| # | Field | Meaning |
|---|---|---|
| 1 | `outcome` | `off`, `too-large`, `limited`, `ready`, `timeout`, `error` or `aborted` (the lifter left the step) |
| 2 | `provider` | `anthropic` or `openai-compatible` |
| 3 | `sessions`, `stretches`, `flags` | The size of the rules' grouping |
| 4 | `setsSent`, `summarizedSessions` | What the request carried; summaries' top sets count as sets |
| 5 | `notesSent` | Whether the lifter chose to send notes |
| 6 | `providerMs`, `durationMs`, `inputTokens`, `outputTokens` | Cost and speed |
| 7 | `suggestions`, `droppedMalformed`, `droppedUnknownLift`, `droppedOutOfRange` | What came back and what validation dropped |

A high `droppedMalformed` count means the model isn't returning the JSON asked for. A high
`droppedOutOfRange` count means it is suggesting dates or programs the file doesn't have.

To see whether suggestions are on, look for the API's startup line `Import suggestions use …`,
or check the `suggestions` field of a `mode=assign` response: `null` means off.

## Remediation

### Configuration

| # | Variable | Value |
|---|---|---|
| 1 | `IMPORT_SUGGESTIONS_PROVIDER` | `anthropic` or `openai-compatible`. No default: unset or empty means off. |
| 2 | `IMPORT_SUGGESTIONS_MODEL` | Required. |
| 3 | `IMPORT_SUGGESTIONS_BASE_URL` | Required for `openai-compatible`, such as `http://127.0.0.1:11434/v1` for Ollama. |
| 4 | `IMPORT_SUGGESTIONS_API_KEY` | The provider's key. `anthropic` falls back to `ANTHROPIC_API_KEY`; a local server ignores it. |

The Assign step itself must be on (`IMPORT_ASSIGN_ENABLED=true`, see
[Turn the import Assign step off](import-assign-flag.md)).

**Turning suggestions on in a deployed environment sends lifters' history to the provider. That's
the owner's decision**, separate from shipping the code. Make it through the deploy the way
`IMPORT_ASSIGN_ENABLED` is set: the API deploy step's `ingress_env` in
`.github/workflows/deploy.yml` (and `staging.yml` for staging), plus
`infra/kubernetes/values/<env>-api.yaml`. Keep the API key in Secret Manager, not in the workflow.

### Turn them off

Set `IMPORT_SUGGESTIONS_PROVIDER` to an empty value, in the deploy and on the live service:

```bash
gcloud run services update lifting-logbook-prod-api --region=us-central1 \
  --project=<GCP_PROD_PROJECT_ID> \
  --container=api --update-env-vars=IMPORT_SUGGESTIONS_PROVIDER=
```

As with the Assign flag, the deploy keeps env vars already on the service, so deleting the line
from the workflow leaves the old value in place. Lifters in the middle of an import see
"Suggestions aren’t available right now" and carry on; nothing they accepted is undone, because
accepting only changes their draft before commit.

### Run a local model with Ollama

Testing with real lift history uses a local model, so the history never leaves the machine. Don't
point a hosted provider at real data to test.

1. Install [Ollama](https://ollama.com/download) and pull a model: `ollama pull qwen3:14b`.
2. Give it a known context window, so you know what fits: Ollama's default depends on its version
   and the machine. Write a file named `Modelfile` containing:

   ```
   FROM qwen3:14b
   PARAMETER num_ctx 32768
   ```

   then run `ollama create qwen3-14b-32k -f Modelfile`
   ([Modelfile reference](https://github.com/ollama/ollama/blob/main/docs/modelfile.md)).
3. In `apps/api/.env`:

   ```
   IMPORT_ASSIGN_ENABLED=true
   IMPORT_SUGGESTIONS_PROVIDER=openai-compatible
   IMPORT_SUGGESTIONS_MODEL=qwen3-14b-32k
   IMPORT_SUGGESTIONS_BASE_URL=http://127.0.0.1:11434/v1
   ```

   Use `127.0.0.1`, not `localhost`, for the reason the Playwright section of `CLAUDE.md` gives.
4. Start the API and web app (`npm run dev`) and import a file. The first request after the model
   loads is slow; warm it with any request first.

The adapter asks for JSON mode, which Ollama's
[OpenAI compatibility](https://github.com/ollama/ollama/blob/main/docs/openai.md) supports, and
skips a `<think>` block if a model puts one before its JSON.

**Measured on 2026-11-14** (qwen3:14b Q4_K_M, `num_ctx` 32768, an RTX 5060 Ti with 16 GB, synthetic
files only):

| # | File | Input tokens | Output tokens | Time | Result |
|---|---|---|---|---|---|
| 1 | 93 sets, two runs and a lone session | 3,239 | 1,443 | 37 s warm | 4 suggestions, 1 dropped |
| 2 | 1,392 sets, four stretches | 31,318 | 1,072 | 60–83 s with no cached prompt; 38 s reusing one | Past the 60-second deadline unless cached |
| 3 | First request after loading the model | | | about 85 s | Past the deadline |

About 22 input tokens per set, so a file at the 1,500-set cap is about 34,000 tokens: more than a
32,768-token window. qwen3:14b's own limit, 40,960, fits that, but on a 16 GB GPU it put 10% of the
model on the CPU. On this hardware, files near the cap time out, and the comparison in
[#1175](https://github.com/merickvaughn/lifting-logbook/issues/1175) is where the cap and
deadline get revisited.

### Verify

Import a file with suggestions on and answer Yes: the panel lists suggestions, or says the model
had none. The log line for the request shows `outcome: "ready"`.

## Escalation

If suggestions are wrong often enough to mislead lifters, turn them off and open an issue with the
log lines' counts. Never paste a prompt or a response from a lifter's file into an issue.

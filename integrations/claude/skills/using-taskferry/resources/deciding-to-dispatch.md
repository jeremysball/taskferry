# Deciding to Dispatch

## Overview

Dispatching a ferry (via `taskferry dispatch`) offloads **real reasoning or work** to a cheaper, external, less-reliable model, spending a network round trip and a dependency on that provider's uptime to save your own session tokens or wall-clock time.

**Core principle:** Dispatch is for work whose value is judgment, synthesis, or volume, not a proxy for your own built-in tools. When Read, Grep/rg, Glob, or Bash can produce the deliverable directly, synchronously, and reliably, use them. Never route trivial I/O through an external model.

This resource is the **upstream gate**: it decides *whether* a task should go to a ferry at all. Once you have decided yes, `taskferry` owns the *how* (model choice, dispatch, monitoring, and validating the deliverable). This resource does not repeat any of that.

## The gate: one self-check

Before you dispatch, strip every word of reasoning, filtering, and synthesis out of the request. Look at what remains as the deliverable:

> **If the deliverable would be a verbatim copy of source material you can fetch yourself in a tool call or two, do not dispatch. Read it yourself.**

A real dispatch survives this test: with the reasoning stripped out, nothing useful is left, because the reasoning *was* the deliverable.

## Do it yourself vs. dispatch

| Do it yourself (never dispatch) | Dispatch (real work) |
|---|---|
| "Read these N files and paste back their contents" | "Read these 15 files and list every function that touches X, with reasoning about why each is relevant" |
| "Run this exact command and tell me the output" | Independent code review of a branch or diff |
| "Cat this config / print this JSON / show this log" | Open-ended web research needing many fetches |
| "Grep for `foo` and give me the matching lines" | Implementing or refactoring code as an executor |
| Any deliverable that is a literal, unmodified copy of one thing | Any task whose value-add is judgment or synthesis, and that would burn real session tokens or time to do inline |

The left column is instant, free, and reliable through your own tools. Sending it to a ferry adds latency and a failure mode for zero benefit.

## Why the gate matters: the cost you are spending

A dispatch is not free even when it works. It adds:

- **Latency.** A process and network round trip, versus an instant local Read.
- **A dependency.** The external provider must be up and not rate-limited. When it is throttled, the dispatch stalls or fails, and a trivial retrieval that Read would have finished in milliseconds hangs indefinitely with zero output. This is not hypothetical: the incident that produced this guidance dispatched "paste back these files" at the exact moment the provider was rate-limited, so the task was doomed regardless.
- **Unreliability.** The external model can summarize when you asked for a literal transcription, hallucinate, or truncate. For retrieval, that turns a guaranteed-correct Read into a maybe-correct paraphrase.

Spend that cost only when the offloaded work genuinely justifies it. Trivial I/O never does.

## Relationship to `taskferry`

- **This resource** answers "should this go to a ferry?" It is the gate.
- **`taskferry`** answers "how do I run it and prove the result?" It owns model selection, dispatch mechanics, monitoring, and deliverable validation, and is the required next step once this gate says yes.

Do not dispatch without passing this gate first, and do not re-derive dispatch mechanics here.

## Red flags: you are about to misuse dispatch

- The prompt you are drafting contains "paste back", "print the contents", "tell me the output of", "read X and show me", or "run Y and report".
- The whole deliverable is one file, one command's output, or one search result, unchanged.
- Your reason for dispatching is "to save my tokens" and nothing else. Token cost is not a reason to offload work you could do in one instant, reliable tool call.

**All of these mean: stop, and use your own Read/Grep/Glob/Bash instead.**

## Common rationalizations

| Excuse | Reality |
|--------|---------|
| "It saves my session tokens" | A Read of a file costs almost nothing and can't fail. Dispatching it costs latency plus a provider dependency to save tokens you weren't going to spend anyway. |
| "It's a research/reporting task, and a ferry does research" | Research means fetching *and synthesizing*. Fetching a known path verbatim is retrieval, not research. Strip the synthesis: if a literal copy is all that's left, it isn't research. |
| "Dispatching frees me to do other things in parallel" | Only worth it if the offloaded work is substantial. For a one-call Read, orchestrating and waiting on a background task costs more attention than just reading the file. |
| "The files are large, so offloading helps" | Size doesn't change who should fetch them. A large file read by a ferry still has to come back to you, now via a slower, less reliable path, and may come back summarized instead of verbatim. |

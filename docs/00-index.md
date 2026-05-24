# AI Data Center — Concept Blogs

A reading order for someone coming from a networking background into AI infrastructure. Each post stands on its own, but they assume you've read the ones above it. Each post is paired with a runnable scenario in [/scenarios](../scenarios/) — read first, then run the scenario to see the concept move.

## Reference docs

- [Lab topology](topology.md) — diagram, per-device factsheets, full link inventory, BGP peer matrix
- [Spine & Leaf CLI reference](switch-cli-reference.md) — verify config, make persistent changes, common failure modes

## Suggested reading order

| # | Post | Pair with scenario | Status |
|---|---|---|---|
| 1 | [East-west traffic dominance](03-east-west-traffic-dominance.md) | `01-allreduce-ring` | 📝 Phase 2 |
| 2 | [Distributed AI training](01-distributed-ai-training.md) | `01-allreduce-ring` | 📝 Phase 2 |
| 3 | [GPU-to-GPU communication](02-gpu-to-gpu-communication.md) | `01-allreduce-ring` + `04-link-failure-ecmp` | 📝 Phase 2 |
| 4 | [Collective operations (AllReduce, Broadcast, Gather)](04-collective-operations.md) | `01-allreduce-ring` | 📝 Phase 2 |
| 5 | [Why synchronization matters](07-why-synchronization-matters.md) | `01` + `04-link-failure-ecmp` | 📝 Phase 3 |
| 6 | [MPI basics](05-mpi-basics.md) | `01-allreduce-ring` (mpi variant) | 📝 Phase 3 |
| 7 | [NCCL fundamentals](06-nccl-fundamentals.md) | — (theory; contrast with our Gloo runs) | 📝 Phase 3 |
| 8 | [GPU utilization bottlenecks](08-gpu-utilization-bottlenecks.md) | `02-incast-congestion`, `03-elephant-vs-mice` | 📝 Phase 3 |
| 9 | [Training vs inference traffic patterns](09-training-vs-inference-traffic.md) | `03-elephant-vs-mice` + (new inference scenario) | 📝 Phase 4 |

Status: `📝` = drafted post-Phase, `🚧` = in-progress, `✅` = complete with lab screenshots.

## Why this order

We start with **east-west dominance** because it answers the "why does an AI DC look different from a web DC?" question in one paragraph — then everything else builds on that. We end with **training vs inference** because that contrast forces you to think about flow size, latency vs throughput, and the operational implications, which is the natural exit ramp toward "ok, how would you actually design this?"

## How the blogs are structured

Each post has the same four sections:

1. **The networking instinct** — what a network engineer's first guess about the topic would be.
2. **What's actually happening** — the AI/ML reality, in network-engineer language.
3. **What the lab shows** — concrete commands, screenshots from Grafana, traces from the scenario.
4. **Interview talking points** — 3–5 things to be ready to discuss when asked about this.

The goal isn't to be a textbook. It's to give you a mental model + a runnable demo, so when an interviewer asks "what happens to the network when an AllReduce stalls?", you have a real answer plus a tab open showing it.

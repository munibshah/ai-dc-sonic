# Lab Guide — Bring up an AI DC fabric the way a network engineer would

You're going to log into each switch through the UI, exactly like an engineer at a hyperscaler logs into a freshly-racked switch through SSH. You'll discover what's there, configure interfaces, configure BGP, watch peers come up, ping neighbors, look at routes. Along the way, every config decision (which ASN, why ECMP, why `multipath-relax`, why fast timers) is paired with **why it matters for AI Data Centers** — connecting the config to AllReduce traffic, training-job continuity, and hyperscale fabric design.

This is the same fabric as the rest of the lab. The only difference is the switches start with no L3 config and no BGP; you build the underlay yourself through the consoles.

---

## What you'll learn

Concepts, not FRR syntax:

- Why **eBGP CLOS** underpins every hyperscale AI fabric (Meta, Microsoft, AWS — all of them)
- **Shared-AS spines** and what they buy you (path-hunting simplicity, no inter-spine peering)
- **Per-leaf unique ASNs** and what they buy you (failure isolation, easy attribution of bad advertisements)
- **ECMP with `multipath-relax`** — and why AllReduce *requires* it to keep GPUs saturated
- **Peer-groups** as operational scaling (one policy block, N neighbors)
- **`/31`s on fabric links**, **loopbacks as router-IDs**, **fast BGP timers** (3s/9s) — why each is industry standard

You will *not* be memorizing FRR command syntax. You'll be running real commands in a real CLI on real (containerised) switches.

---

## Teaching philosophy

You're a network engineer. A fresh AI fabric has been racked. The console for each switch is one click away in the lab UI. Your job is to bring it up.

For each switch you'll:

1. **Discover** — `ip -br link show`, `ip -br addr show`. What ports are there? Are any IPs assigned?
2. **Configure** — drop into `vtysh`, the FRR CLI. Add interface IPs, configure BGP, activate the address family.
3. **Verify** — `show interface brief`, `show bgp summary`, `show ip route`. Did the session come up? Did routes arrive?
4. **Test** — `ping` from the switch, `ping` from a GPU. Does end-to-end actually work?

Each step has a **💡 Why this matters in AI DCs** callout explaining the *reason* behind the config — what would break in a real AllReduce workload if you skipped it, why hyperscalers do it this way, what the failure mode looks like at scale.

---

## Prerequisites

Your instructor (or you, as the operator) has deployed the fabric — 16 containers running on the lab host: 2 spines, 4 leaves, 8 GPU workers, the orchestrator, and this UI. The lab is reachable in your browser at the host's port 3000. If you're the operator setting this up, see the top-level `README.md`; everything below assumes the lab is up.

Open the lab index → click **Lab 1 · Build the BGP Underlay**. You'll land on this workbench: guide on the left, terminals on the right, control bar across the top with **Start lab ▶**, **Reset**, **Solve**, **Reveal solution**, **Submit ✓**.

---

## The workflow loop

For each switch:

1. Click **Topology** in the top bar, or **+** in the terminals pane, and pick the switch — its console tab opens (a real `docker exec -it <switch> bash` over a WebSocket PTY).
2. Discover current state with `ip -br link show`, `ip -br addr show`.
3. Enter `vtysh`, then `configure terminal`.
4. Configure interfaces (loopback + fabric P2Ps).
5. Configure BGP (router-id, peer-group, neighbors, address-family).
6. Verify with `do show ip bgp summary`, `do show ip route`.
7. Exit vtysh, `ping` a neighbor to confirm L3 reachability.
8. Click the inline **Check ▸** widget under the step to confirm — pass/fail comes back in ~2 seconds.

Per-switch IP/ASN inputs come from [`../topology.md`](../topology.md) §3 (per-device factsheets) and §5 (BGP peer matrix). Keep that doc open in another tab.

---

## Persistence note (important!)

The commands you run in `vtysh` go straight to the running FRR daemons. **They are not written back to disk.** If a switch container restarts, your work disappears — but the orchestrator never restarts switch containers, so you can safely walk away. Close the browser and come back tomorrow; your **session, lab state, attempts counter, and last submit result all persist** server-side.

If you get stuck:

- **Reveal solution** — show the canonical vtysh sequence side-by-side with your work.
- **Solve** — push the canonical config into the live fabric (your run is flagged "solved" in the completion screen).
- **Reset** — wipe everything back to a bare fabric and try again from scratch.

---

## Where to go

- **[`01-exercise.md`](01-exercise.md)** — the guided walkthrough. Start here. Each step has the commands to run, the expected output, and the AI-DC *why*.
- **[`02-solution.md`](02-solution.md)** — pure commands. If you just want the answer key for a single switch, or want to compare your work against the canonical version.

Reference material you'll need open in another tab:

- **[`../topology.md`](../topology.md)** — every IP, every link, every ASN. Don't memorize; look it up.
- **[`../switch-cli-reference.md`](../switch-cli-reference.md)** — vtysh + ip command cheat sheet.

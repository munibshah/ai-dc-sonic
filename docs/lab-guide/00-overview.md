# Lab Guide — Build the underlay yourself

Hands-on exercise to configure the BGP underlay of the AI DC fabric from scratch. By the end you'll have all 8 GPU workers pinging each other across two spines via ECMP.

This is the **same** fabric as the rest of the lab — the only difference is that the switch FRR configs start blank, and you fill them in.

---

## What you're learning

- eBGP CLOS underlay with **shared-AS spines** (both spines are AS 65000)
- BGP **peer-groups** to avoid repetition
- `bestpath as-path multipath-relax` — why ECMP across shared-AS spines needs it
- `maximum-paths 64` — how to let the FIB carry multiple equal-cost next-hops
- `network` statements for advertising loopbacks + downstream subnets without `redistribute connected`
- The `no bgp default ipv4-unicast` + `neighbor X activate` pattern (explicit AF activation)
- The edit → sync → bootstrap → verify loop on a per-switch FRR config

---

## Prerequisites

The lab must be deployed in baseline state. From the repo root on your laptop:

```bash
make pull             # one-time: pull sonic-vs + build worker image (~5 min)
make warm             # bring up 14 containers + apply working configs (~3 min)
make ping-mesh        # confirm 56/56 OK
```

If `make warm` finishes with all 56 pings OK, you're ready. Then enter exercise mode with `make wipe`.

---

## Workflow

You'll cycle through this loop for each switch you configure:

```bash
$EDITOR configs/frr/<node>/frr.conf       # edit (the file is empty/skeleton at start)
make sync                                  # rsync changes to the remote
make fabric-bootstrap                      # vtysh -b on every switch loads the new config
make shell-<node>                          # log in to verify
```

The `bootstrap-switch.sh` script that `make fabric-bootstrap` runs is the same script that the working lab uses — see [configs/frr/bootstrap-switch.sh](../../configs/frr/bootstrap-switch.sh). It restarts `zebra`/`bgpd`/`staticd`, then runs `vtysh -b /etc/frr/frr.conf` to load the bind-mounted config.

---

## Reset commands

```bash
make wipe         # copy configs/frr/_skeleton/* over the working configs, apply,
                  # and the lab goes to "exercise" state (no BGP anywhere)
make solve        # git checkout the working configs, apply, lab returns to working state
make lab-status   # quick "am I done?" — runs bgp-check + ping-mesh and shows totals
```

`make solve` is the "I give up / show me the answer" button. It uses `git checkout` to restore `configs/frr/<node>/frr.conf` to whatever's committed in your current branch — which on a fresh clone is the full working config.

---

## Where to go

- [`01-exercise.md`](01-exercise.md) — the problem statement and tasks. Start here.
- [`02-solution.md`](02-solution.md) — full annotated configs + verification. Look here if stuck (or after you finish, to compare).

For reference while you're working:

- [`../topology.md`](../topology.md) — every IP, every link, every BGP peer. Don't memorize the addressing math, just look it up.
- [`../switch-cli-reference.md`](../switch-cli-reference.md) — all the `vtysh` and `ip` commands you'll need.

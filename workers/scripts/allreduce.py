#!/usr/bin/env python3
"""Gloo-backed AllReduce across the lab's workers.

Runs on every worker simultaneously (one process per worker). Each rank
creates a tensor filled with its rank value, AllReduce-sums it across the
world, and verifies the result equals sum(0..world_size-1).

The orchestrator's Lab 3 checkpoints invoke this with --rank/--world-size
per worker via docker exec, fanning out to all eight gpus in parallel. The
exercise also drives a 2-rank version by hand from the in-browser console
to give learners a feel for how Gloo's rendezvous works before the full
8-way collective.

Wire-level traffic: Gloo's CPU AllReduce uses a ring algorithm — each
rank exchanges (n-1)/n of the tensor with its neighbour in 2*(n-1) steps.
Every step is a TCP send/recv; with all 8 ranks on the same 192.168.100.0/24
overlay, every byte rides a VXLAN tunnel through the underlay.

CLI:
  --rank N             this worker's rank (0..world_size-1)
  --world-size N       total worker count
  --master IP          IP of the rank-0 worker (rendezvous master)
  --port PORT          rendezvous TCP port (default 29500)
  --elements N         float32 elements per tensor (default 1,000,000 = 4 MB)
  --iters N            timed iterations after one warmup (default 5)
"""
from __future__ import annotations

import argparse
import datetime as _dt
import os
import socket
import sys
import time

import torch
import torch.distributed as dist


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--rank", type=int, required=True)
    p.add_argument("--world-size", type=int, required=True)
    p.add_argument("--master", required=True, help="IP of rank 0 (rendezvous master)")
    p.add_argument("--port", type=int, default=29500)
    p.add_argument("--elements", type=int, default=1_000_000)
    p.add_argument("--iters", type=int, default=5)
    args = p.parse_args()

    os.environ["MASTER_ADDR"] = args.master
    os.environ["MASTER_PORT"] = str(args.port)
    os.environ["RANK"] = str(args.rank)
    os.environ["WORLD_SIZE"] = str(args.world_size)
    os.environ.setdefault("GLOO_SOCKET_IFNAME", "eth1")

    host = socket.gethostname()
    print(f"[rank {args.rank} @ {host}] init_process_group master={args.master}:{args.port} ...", flush=True)
    dist.init_process_group(
        backend="gloo",
        timeout=_dt.timedelta(seconds=60),
    )
    print(f"[rank {args.rank} @ {host}] joined world of {args.world_size}", flush=True)

    tensor = torch.full((args.elements,), float(args.rank), dtype=torch.float32)
    expected = float(sum(range(args.world_size)))

    # one warmup pass — Gloo lazily opens TCP connections on first call
    warm = tensor.clone()
    dist.all_reduce(warm, op=dist.ReduceOp.SUM)
    if not torch.all(warm == expected):
        print(f"[rank {args.rank}] WARMUP FAILED: got {warm[0].item()}, expected {expected}", flush=True)
        dist.destroy_process_group()
        return 2

    times: list[float] = []
    for i in range(args.iters):
        t = tensor.clone()
        dist.barrier()
        t0 = time.monotonic()
        dist.all_reduce(t, op=dist.ReduceOp.SUM)
        t1 = time.monotonic()
        times.append(t1 - t0)
        if not torch.all(t == expected):
            print(f"[rank {args.rank}] iter {i} WRONG: got {t[0].item()}, expected {expected}", flush=True)
            dist.destroy_process_group()
            return 3

    avg_s = sum(times) / len(times)
    bytes_per_iter = args.elements * 4  # float32
    # Ring AllReduce moves 2*(n-1)/n * tensor_bytes per rank
    busbytes = 2 * (args.world_size - 1) / args.world_size * bytes_per_iter
    mbps = busbytes / avg_s / 1e6 * 8

    print(
        f"[rank {args.rank} @ {host}] OK "
        f"avg={avg_s*1000:.1f}ms "
        f"min={min(times)*1000:.1f}ms "
        f"max={max(times)*1000:.1f}ms "
        f"elements={args.elements} "
        f"world={args.world_size} "
        f"effective_bw={mbps:.0f}Mbps",
        flush=True,
    )

    dist.destroy_process_group()
    return 0


if __name__ == "__main__":
    sys.exit(main())

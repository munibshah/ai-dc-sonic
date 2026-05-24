"""
Smoke test: open the console WebSocket against leaf1, send a vtysh command,
read the output back. Used by `make ui-smoke`.
"""
from __future__ import annotations
import asyncio
import json
import sys
import websockets


async def main(name: str, cmd: str) -> int:
    uri = f"ws://localhost:8000/ws/console/{name}"
    print(f"[smoke] connecting {uri}", flush=True)
    async with websockets.connect(uri) as ws:
        # Resize on connect
        await ws.send(json.dumps({"type": "resize", "rows": 24, "cols": 120}))
        # Give the shell a beat
        await asyncio.sleep(1.0)
        # Drain prompt
        await drain(ws, timeout=1.0)
        # Send command
        print(f"[smoke] sending: {cmd!r}", flush=True)
        await ws.send(cmd + "\n")
        # Read up to 3 seconds of output
        out = await drain(ws, timeout=3.0)
        sys.stdout.write(out.decode(errors="replace"))
        sys.stdout.write("\n[smoke] done\n")
    return 0


async def drain(ws, timeout: float) -> bytes:
    buf = bytearray()
    end = asyncio.get_event_loop().time() + timeout
    while True:
        remaining = end - asyncio.get_event_loop().time()
        if remaining <= 0:
            break
        try:
            msg = await asyncio.wait_for(ws.recv(), timeout=remaining)
        except asyncio.TimeoutError:
            break
        if isinstance(msg, (bytes, bytearray)):
            buf.extend(msg)
        else:
            buf.extend(msg.encode())
    return bytes(buf)


if __name__ == "__main__":
    n = sys.argv[1] if len(sys.argv) > 1 else "leaf1"
    c = sys.argv[2] if len(sys.argv) > 2 else "vtysh -c 'show ip bgp summary' | head -8"
    sys.exit(asyncio.run(main(n, c)))

"""Run the whole protocol in one process, without Flower.

Same Hospital and Aggregator code as the Flower deployment; only the transport
differs (direct function calls on a thread pool). Useful for quick experiments,
tests, and as a fallback if the Flower deployment gives trouble.

  python -m cerebrachain.local_run --rounds 3 --attack boost --attacker 3

Needs the trust layer running (npm run trust-layer, or scripts/run_demo.sh --local).
"""
from __future__ import annotations

import argparse
import json
import os
from concurrent.futures import ThreadPoolExecutor

import torch

from .aggregator import Aggregator, FedConfig
from .hospital import Hospital
from .zk import chunk_size


class LocalTransport:
    def __init__(self, hospitals: dict[int, Hospital], workers: int = 4):
        self.h = hospitals
        self.pool = ThreadPoolExecutor(max_workers=workers)

    def discover(self, timeout):
        res = self.call("register", {hid: {"config": {}, "arrays": {}} for hid in self.h}, timeout)
        return {hid: rep["config"] for hid, rep in res.items() if not isinstance(rep, Exception)}

    def call(self, msg_type, payloads, timeout):
        futs = {hid: self.pool.submit(self.h[hid].handle, msg_type, p) for hid, p in payloads.items()}
        out = {}
        for hid, f in futs.items():
            try:
                out[hid] = f.result(timeout=timeout)
            except Exception as e:  # noqa: BLE001 - reported per hospital
                out[hid] = e
        return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--hospitals", type=int, default=4)
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--clip-norm", type=float, default=2.0)
    ap.add_argument("--attack", choices=["none", "boost", "tamper"], default="none")
    ap.add_argument("--attacker", type=int, default=3, help="hospital id of the attacker")
    ap.add_argument("--attack-rounds", default="all", help="'all' or comma list, e.g. 2,3")
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--work-dir", default="runs/local")
    ap.add_argument("--trust-url", default=os.environ.get("TRUST_URL", "http://127.0.0.1:8787"))
    ap.add_argument("--device", default="auto")
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args(argv)

    torch.set_num_threads(max(1, (os.cpu_count() or 2) // max(1, a.workers)))
    hospitals = {
        i: Hospital(i, a.data_dir, a.work_dir, device=a.device, trust_url=a.trust_url,
                    attack=a.attack if i == a.attacker else "none", attack_rounds=a.attack_rounds)
        for i in range(a.hospitals)
    }
    cfg = FedConfig(rounds=a.rounds, epochs=a.epochs, lr=a.lr, clip_norm=a.clip_norm, trust_url=a.trust_url)
    agg = Aggregator(cfg, LocalTransport(hospitals, a.workers), chunk_size())
    print(json.dumps(agg.config_dict()))
    history = agg.run()
    print(json.dumps(history, indent=1))


if __name__ == "__main__":
    main()

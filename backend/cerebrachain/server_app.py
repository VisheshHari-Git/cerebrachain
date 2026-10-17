"""Flower ServerApp: the federated aggregator.

Configured from [tool.flwr.app.config] in pyproject.toml (override with
`flwr run . <connection> --run-config "num-server-rounds=5"`).
"""
from __future__ import annotations

import os
import time

from flwr.app import Context, Message
from flwr.serverapp import Grid, ServerApp

from .aggregator import Aggregator, FedConfig
from .flower_io import MESSAGE_TYPES, from_record, to_record
from .zk import chunk_size

app = ServerApp()


class FlowerTransport:
    def __init__(self, grid: Grid, expected: int, log=print):
        self.grid = grid
        self.expected = expected
        self.node_of: dict[int, int] = {}
        self.log = log

    def discover(self, timeout):
        deadline = time.time() + timeout
        while True:
            nodes = list(self.grid.get_node_ids())
            if len(nodes) >= self.expected:
                break
            if time.time() > deadline:
                raise TimeoutError(f"only {len(nodes)}/{self.expected} hospital nodes connected")
            self.log(f"waiting for hospital nodes: {len(nodes)}/{self.expected} connected")
            time.sleep(3)
        msgs = [Message(to_record({}), dst_node_id=n, message_type=MESSAGE_TYPES["register"]) for n in nodes]
        info = {}
        for rep in self.grid.send_and_receive(msgs, timeout=timeout):
            if rep.has_error():
                self.log(f"node {rep.metadata.src_node_id} failed to register: {rep.error.reason}")
                continue
            cfg = from_record(rep.content)["config"]
            hid = int(cfg["hospital_id"])
            if hid in info:
                raise RuntimeError(f"two nodes claim hospital id {hid}; check --node-config")
            self.node_of[hid] = rep.metadata.src_node_id
            info[hid] = cfg
        return info

    def call(self, msg_type, payloads, timeout):
        mtype = MESSAGE_TYPES[msg_type]
        hid_of = {self.node_of[h]: h for h in payloads}
        msgs = [Message(to_record(p), dst_node_id=self.node_of[h], message_type=mtype)
                for h, p in payloads.items()]
        out: dict[int, dict | Exception] = {h: TimeoutError("no reply") for h in payloads}
        for rep in self.grid.send_and_receive(msgs, timeout=timeout):
            h = hid_of.get(rep.metadata.src_node_id)
            if h is None:
                continue
            out[h] = RuntimeError(rep.error.reason) if rep.has_error() else from_record(rep.content)
        return out


@app.main()
def main(grid: Grid, context: Context) -> None:
    rc = context.run_config
    root = str(rc.get("project-root", "") or os.environ.get("CEREBRA_ROOT", ""))
    if root:
        os.environ["CEREBRA_ROOT"] = root
    cfg = FedConfig(
        rounds=int(rc.get("num-server-rounds", 5)),
        epochs=int(rc.get("local-epochs", 3)),
        lr=float(rc.get("lr", 2e-3)),
        batch_size=int(rc.get("batch-size", 16)),
        clip_norm=float(rc.get("clip-norm", 2.0)),
        min_survivors=int(rc.get("min-survivors", 2)),
        timeout=float(rc.get("timeout", 3600)),
        trust_url=str(rc.get("trust-url", "http://127.0.0.1:8787")),
    )

    def log(m):
        print(f"[aggregator] {m}", flush=True)

    transport = FlowerTransport(grid, int(rc.get("expected-hospitals", 4)), log)
    agg = Aggregator(cfg, transport, chunk_size(root or None), log=log)
    log(f"config: {agg.config_dict()}")
    for res in agg.run():
        log(f"summary: {res}")

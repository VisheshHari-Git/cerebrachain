"""Flower ClientApp: one per hospital (each runs inside its own Flower SuperNode).

The SuperNode is started with --node-config, e.g.
  flower-supernode --insecure --superlink 127.0.0.1:9092 --clientappio-api-address ... \
    --node-config "hospital-id=0 data-dir='/abs/data' work-dir='/abs/runs/flower' project-root='/abs'"
"""
from __future__ import annotations

import os

import torch
from flwr.app import Context, Message
from flwr.clientapp import ClientApp

from .flower_io import from_record, to_record
from .hospital import Hospital

app = ClientApp()
_HOSPITALS: dict[int, Hospital] = {}


def _hospital(ctx: Context) -> Hospital:
    nc = ctx.node_config
    hid = int(nc["hospital-id"])
    if hid not in _HOSPITALS:
        root = str(nc.get("project-root", os.environ.get("CEREBRA_ROOT", "")) or "") or None
        if root:
            os.environ["CEREBRA_ROOT"] = root
        torch.set_num_threads(int(nc.get("torch-threads", 2)))
        _HOSPITALS[hid] = Hospital(
            hid,
            data_dir=str(nc.get("data-dir", "data")),
            work_dir=str(nc.get("work-dir", "runs/flower")),
            device=str(nc.get("device", "auto")),
            attack=str(nc.get("attack", "none")),
            attack_rounds=str(nc.get("attack-rounds", "all")),
            trust_url=str(nc.get("trust-url", "http://127.0.0.1:8787")),
            root=root,
        )
    return _HOSPITALS[hid]


def _handle(kind: str, msg: Message, ctx: Context) -> Message:
    out = _hospital(ctx).handle(kind, from_record(msg.content))
    return Message(to_record(out), reply_to=msg)


@app.query("register")
def register(msg: Message, ctx: Context) -> Message:
    return _handle("register", msg, ctx)


@app.train("commit")
def commit(msg: Message, ctx: Context) -> Message:
    return _handle("commit", msg, ctx)


@app.train("prove")
def prove(msg: Message, ctx: Context) -> Message:
    return _handle("prove", msg, ctx)


@app.query("unmask")
def unmask(msg: Message, ctx: Context) -> Message:
    return _handle("unmask", msg, ctx)


@app.evaluate()
def evaluate(msg: Message, ctx: Context) -> Message:
    return _handle("evaluate", msg, ctx)

"""Conversion between protocol payloads and Flower messages."""
from __future__ import annotations

import json

import numpy as np
from flwr.app import Array, ArrayRecord, ConfigRecord, RecordDict

MESSAGE_TYPES = {
    "register": "query.register",
    "commit": "train.commit",
    "prove": "train.prove",
    "unmask": "query.unmask",
    "evaluate": "evaluate",
}


def to_record(payload: dict) -> RecordDict:
    rd = RecordDict()
    rd["config"] = ConfigRecord({"json": json.dumps(payload.get("config", {}))})
    arrays = payload.get("arrays") or {}
    rd["arrays"] = ArrayRecord({k: Array(np.ascontiguousarray(v)) for k, v in arrays.items()})
    return rd


def from_record(rd: RecordDict) -> dict:
    cfg = json.loads(rd["config"]["json"]) if "config" in rd else {}
    arrays = {k: v.numpy() for k, v in rd["arrays"].items()} if "arrays" in rd else {}
    return {"config": cfg, "arrays": arrays}

"""Aggregator: orchestrates one federated round end to end.

    open round (trust layer + chain)
      -> COMMIT    hospitals train locally, commit to their int8 update, upload a masked copy
      -> challenge Fiat-Shamir seed from all commitments + masked uploads (on-chain)
      -> PROVE     hospitals prove: committed, int8, norm, bound to this round, polynomial eval
      -> VERIFY    trust layer verifies off-chain and on-chain; bad hospitals are excluded
      -> UNMASK    survivors reveal only their pairwise seeds with excluded hospitals
      -> AGGREGATE secure sum of survivors; check sum(n_i * eval_i) == eval(sum) per chunk
      -> UPDATE    FedAvg on the dequantised sum, publish model hash + IPFS CID on-chain
      -> EVALUATE  every hospital reports validation Dice of the new model

The aggregator never sees an individual hospital's update or any MRI.
Transport-agnostic: see FlowerTransport (server_app.py) and LocalTransport (local_run.py).
"""
from __future__ import annotations

import base64
import json
import time
from dataclasses import asdict, dataclass
from typing import Callable, Protocol

import numpy as np

from . import quant, secagg
from .fields import R, poly_eval, x_for
from .model import build_model, federated_keys, get_flat, model_hash
from .trust_client import TrustClient


@dataclass
class FedConfig:
    rounds: int = 5
    epochs: int = 3
    lr: float = 2e-3
    batch_size: int = 16
    clip_norm: float = 2.0
    quant_resolution: float = 16.0
    min_survivors: int = 2
    max_samples: int = 100_000
    timeout: float = 3600.0
    trust_url: str = "http://127.0.0.1:8787"


class Transport(Protocol):
    def call(self, msg_type: str, payloads: dict[int, dict], timeout: float) -> dict[int, dict | Exception]: ...
    def discover(self, timeout: float) -> dict[int, dict]: ...


class Aggregator:
    def __init__(self, cfg: FedConfig, transport: Transport, chunk_size: int,
                 log: Callable[[str], None] = print):
        self.cfg = cfg
        self.t = transport
        self.trust = TrustClient(cfg.trust_url)
        self.chunk_size = chunk_size
        self.log = log
        model = build_model(seed=0)
        self.keys = federated_keys(model)
        self.g = get_flat(model, self.keys)
        self.dim = len(self.g)
        self.scale = quant.default_scale(cfg.clip_norm, self.dim, cfg.quant_resolution)
        self.bound = quant.norm_bound(cfg.clip_norm, self.scale, self.dim)
        self.k = quant.num_chunks(self.dim, chunk_size)
        self.hospitals: dict[int, dict] = {}
        self.history: list[dict] = []
        self.round0 = 0

    # ------------------------------------------------------------------ setup
    def setup(self):
        self.trust.health()
        self.round0 = int(self.trust.reset().get("firstRound", 1)) - 1
        self.hospitals = self.t.discover(self.cfg.timeout)
        if len(self.hospitals) < self.cfg.min_survivors:
            raise RuntimeError(f"need at least {self.cfg.min_survivors} hospitals, found {len(self.hospitals)}")
        for hid, h in sorted(self.hospitals.items()):
            self.trust.register_hospital(id=hid, name=h["name"], pubkey=h["pubkey"],
                                         numSamples=h["num_samples"], device=h.get("device"))
        self.log(f"{len(self.hospitals)} hospitals registered; {self.dim:,} federated parameters "
                 f"-> {self.k} chunk proofs of {self.chunk_size} per hospital per round")
        res = self._call("evaluate", {hid: self._global_payload() for hid in self.hospitals})
        for hid, rep in res.items():
            if not isinstance(rep, Exception):
                self.trust.initial_metrics(**rep["config"], hospitalId=hid)
        self.log("baseline Dice (untrained model): " + self._fmt_dice(res))

    def run(self):
        self.setup()
        for r in range(1, self.cfg.rounds + 1):
            self.history.append(self.run_round(self.round0 + r))
        return self.history

    # ------------------------------------------------------------------ helpers
    def _global_payload(self, extra=None):
        return {"config": {**(extra or {})}, "arrays": {"global": self.g}}

    def _call(self, msg_type, payloads):
        return self.t.call(msg_type, payloads, self.cfg.timeout)

    @staticmethod
    def _fmt_dice(res):
        parts = [f"{hid}:{rep['config']['dice']:.3f}" for hid, rep in sorted(res.items())
                 if not isinstance(rep, Exception)]
        return " ".join(parts)

    def _finalize(self, r, updated, note, t0, **kw):
        timings = {"round_seconds": round(time.time() - t0, 1)}
        body = dict(updated=updated, note=note, timings=timings, **kw)
        if updated:
            body["newGlobalModelHash"] = "0x" + model_hash(self.g).hex()
            body["modelB64"] = base64.b64encode(np.ascontiguousarray(self.g, "<f4").tobytes()).decode()
        self.trust.finalize(r, **body)
        self.log(f"round {r}: {'UPDATED' if updated else 'ABORTED'} — {note}")
        return {"round": r, "updated": updated, "note": note, **timings}

    # ------------------------------------------------------------------ round
    def run_round(self, r: int) -> dict:
        t0 = time.time()
        cfg = self.cfg
        ghash = model_hash(self.g)
        ids = sorted(self.hospitals)
        pubkeys = [self.hospitals[h]["pubkey"] for h in ids]
        self.trust.open_round(round=r, globalModelHash="0x" + ghash.hex(), normBound=str(self.bound),
                              numChunks=self.k, chunkSize=self.chunk_size, scale=self.scale,
                              clipNorm=cfg.clip_norm, dim=self.dim, participants=ids)
        self.log(f"round {r}: training + committing at {len(ids)} hospitals")

        # ---- COMMIT
        round_cfg = {"round": r, "global_hash": ghash.hex(), "scale": self.scale, "clip_norm": cfg.clip_norm,
                     "norm_bound": self.bound, "chunk_size": self.chunk_size, "participants": ids,
                     "pubkeys": pubkeys, "epochs": cfg.epochs, "lr": cfg.lr, "batch_size": cfg.batch_size}
        replies = self._call("commit", {h: self._global_payload(round_cfg) for h in ids})
        committed: dict[int, dict] = {}
        for hid in ids:
            rep = replies.get(hid)
            if rep is None or isinstance(rep, Exception):
                self.log(f"round {r}: hospital {hid} failed to commit: {rep}")
                continue
            c, y = rep["config"], np.asarray(rep["arrays"]["masked"], np.uint64)
            if len(y) != self.dim or secagg.masked_hash(y).hex() != c["masked_hash"]:
                self.log(f"round {r}: hospital {hid} sent a malformed masked update; ignoring")
                continue
            if not 0 < int(c["num_samples"]) <= cfg.max_samples:
                self.log(f"round {r}: hospital {hid} claimed an implausible sample count; ignoring")
                continue
            self.trust.commit(r, hospitalId=hid, commitmentRoot="0x" + c["commitment_root"],
                              maskedHash="0x" + c["masked_hash"], numSamples=int(c["num_samples"]))
            committed[hid] = {"config": c, "masked": y}
        seed = bytes.fromhex(self.trust.close_commits(r)["seed"][2:])

        # ---- PROVE + VERIFY
        self.log(f"round {r}: {len(committed)} commitments; challenge issued, hospitals proving")
        replies = self._call("prove", {h: {"config": {"round": r, "seed": seed.hex()}, "arrays": {}} for h in committed})
        accepted: dict[int, dict] = {}
        for hid in committed:
            rep = replies.get(hid)
            if rep is None or isinstance(rep, Exception):
                self.trust.mark_missing(r, hid, f"no proof: {str(rep)[:120]}")
                continue
            res = self.trust.submit_proofs(r, hospitalId=hid, proofs=json.loads(rep["config"]["proofs"]),
                                           proveSeconds=rep["config"].get("prove_seconds"))
            if res["status"] == "accepted":
                accepted[hid] = {**committed[hid], "evals": [int(e) for e in res["evals"]]}
            else:
                self.log(f"round {r}: hospital {hid} REJECTED: {res.get('reason')}")
        excluded = [h for h in ids if h not in accepted]

        if len(accepted) < cfg.min_survivors:
            return self._finalize(r, False, f"only {len(accepted)} verified hospitals (< {cfg.min_survivors}); "
                                            "aggregating would expose individual updates", t0, accepted=list(accepted))

        # ---- UNMASK (only seeds shared with excluded hospitals, only this round)
        revealed: dict[tuple[int, int], bytes] = {}
        if excluded:
            self.log(f"round {r}: excluded {excluded}; asking survivors to cancel their masks with them")
            ucfg = {"round": r, "excluded": excluded, "participants": ids, "pubkeys": pubkeys,
                    "min_survivors": cfg.min_survivors}
            replies = self._call("unmask", {h: {"config": ucfg, "arrays": {}} for h in accepted})
            for hid in accepted:
                rep = replies.get(hid)
                if rep is None or isinstance(rep, Exception):
                    return self._finalize(r, False, f"hospital {hid} refused/failed to unmask: {str(rep)[:160]}",
                                          t0, accepted=list(accepted))
                for eid, s in rep["config"]["seeds"].items():
                    revealed[(hid, int(eid))] = bytes.fromhex(s)

        # ---- SECURE AGGREGATION + consistency check against the proofs
        agg = secagg.aggregate({h: a["masked"] for h, a in accepted.items()}, revealed)
        padded = np.zeros(self.k * self.chunk_size, np.int64)
        padded[: self.dim] = agg
        bad = []
        for kk in range(self.k):
            lhs = sum(int(a["config"]["num_samples"]) * a["evals"][kk] for a in accepted.values()) % R
            rhs = poly_eval([int(v) for v in padded[kk * self.chunk_size:(kk + 1) * self.chunk_size]],
                            x_for(seed, kk))
            if lhs != rhs:
                bad.append(kk)
        check = {"passed": not bad, "chunks": self.k,
                 "detail": f"mismatch in chunks {bad}" if bad else "sum of proven evaluations == evaluation of the secure sum"}
        if bad:
            return self._finalize(r, False, "secure-aggregation sum does not match the proven commitments — a "
                                            "hospital uploaded something other than what it proved; round discarded",
                                  t0, aggregateCheck=check, accepted=list(accepted))

        # ---- FedAvg update
        n_total = sum(int(a["config"]["num_samples"]) for a in accepted.values())
        self.g = (self.g.astype(np.float64) + agg.astype(np.float64) * self.scale / n_total).astype(np.float32)
        names = ", ".join(self.hospitals[h]["name"] for h in accepted)
        out = self._finalize(r, True, f"FedAvg over {len(accepted)} verified hospitals ({names})", t0,
                             aggregateCheck=check, accepted=list(accepted))

        # ---- EVALUATE
        res = self._call("evaluate", {hid: self._global_payload({"round": r}) for hid in self.hospitals})
        for hid, rep in res.items():
            if not isinstance(rep, Exception):
                self.trust.metrics(r, **rep["config"], hospitalId=hid)
        self.log(f"round {r}: Dice " + self._fmt_dice(res))
        out["dice"] = {hid: rep["config"]["dice"] for hid, rep in res.items() if not isinstance(rep, Exception)}
        return out

    def config_dict(self):
        return {**asdict(self.cfg), "dim": self.dim, "scale": self.scale, "norm_bound": self.bound,
                "chunks": self.k, "chunk_size": self.chunk_size}

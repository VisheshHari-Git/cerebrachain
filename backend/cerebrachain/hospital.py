"""Hospital node: everything that runs inside one hospital.

Raw MRI never leaves this object. What leaves, per round:
  phase "commit"   commitment root, masked update (uint64, unreadable on its own), sample count
  phase "prove"    Groth16 proofs about the committed update
  phase "unmask"   only if another hospital was excluded: the pairwise mask seed shared
                   with that excluded hospital, for this round only
  phase "evaluate" validation Dice of the new global model on local data

The handler is transport-agnostic: Flower (client_app.py) and the in-process
runner (local_run.py) both call ``Hospital.handle(msg_type, payload)``.
A payload is ``{"config": <json-able dict>, "arrays": {name: np.ndarray}}``.
"""
from __future__ import annotations

import json
import os
import time

import numpy as np
import requests
import torch

from . import quant, secagg, zk
from .data import load_hospital
from .fields import commitment_root, ctx_for, x_for
from .model import build_model, federated_keys, get_flat, model_hash, set_flat
from .train import evaluate, pick_device, recalibrate_bn, train_local

ATTACKS = ("none", "boost", "tamper")


def hospital_name(hid: int) -> str:
    return f"Hospital {chr(65 + hid)}" if hid < 26 else f"Hospital {hid}"


class Hospital:
    def __init__(self, hospital_id: int, data_dir: str, work_dir: str, *, device: str = "auto",
                 attack: str = "none", attack_rounds: str = "all", boost_factor: float = 10.0,
                 trust_url: str | None = None, root: str | None = None, seed: int = 0):
        if attack not in ATTACKS:
            raise ValueError(f"attack must be one of {ATTACKS}")
        self.id = int(hospital_id)
        self.name = hospital_name(self.id)
        self.data_dir = data_dir
        self.work_dir = os.path.join(work_dir, f"hospital_{self.id}")
        os.makedirs(self.work_dir, exist_ok=True)
        self.device = pick_device(device)
        self.attack = attack
        self.attack_rounds = attack_rounds
        self.boost_factor = boost_factor
        self.trust_url = trust_url
        self.root = root
        self.rng = np.random.default_rng(seed * 104729 + self.id)
        self.key = secagg.load_or_create_key(os.path.join(self.work_dir, "x25519.key"))
        self.model = build_model(seed=0)
        self.keys = federated_keys(self.model)
        self.state_path = os.path.join(self.work_dir, "local_model.pt")
        if os.path.exists(self.state_path):
            self.model.load_state_dict(torch.load(self.state_path, weights_only=True))

    # ------------------------------------------------------------------ #
    def handle(self, msg_type: str, payload: dict) -> dict:
        fn = {
            "register": self._register,
            "commit": self._commit,
            "prove": self._prove,
            "unmask": self._unmask,
            "evaluate": self._evaluate,
        }.get(msg_type)
        if fn is None:
            raise ValueError(f"unknown message type {msg_type}")
        return fn(payload.get("config", {}), payload.get("arrays", {}))

    def _attacking(self, round_id: int) -> bool:
        if self.attack == "none":
            return False
        if self.attack_rounds in ("all", "", None):
            return True
        return round_id in {int(x) for x in str(self.attack_rounds).split(",") if x.strip()}

    def _round_file(self, r: int) -> str:
        return os.path.join(self.work_dir, f"round_{r}.json")

    def _save_local(self):
        torch.save(self.model.state_dict(), self.state_path)

    # ------------------------------------------------------------------ #
    def _register(self, cfg, arrays):
        X, _ = load_hospital(self.data_dir, self.id, "train")
        return {"config": {"hospital_id": self.id, "name": self.name,
                           "pubkey": secagg.public_bytes(self.key).hex(), "num_samples": int(len(X)),
                           "device": str(self.device)}, "arrays": {}}

    def _commit(self, cfg, arrays):
        r = int(cfg["round"])
        g = np.asarray(arrays["global"], np.float32)
        ghash = bytes.fromhex(cfg["global_hash"])
        if model_hash(g) != ghash:
            raise ValueError("global model does not match the announced hash; refusing to train")
        scale, clip_norm, bound = float(cfg["scale"]), float(cfg["clip_norm"]), int(cfg["norm_bound"])
        n_chunk = int(cfg["chunk_size"])

        # 1. Local training on private MRI
        X, Y = load_hospital(self.data_dir, self.id, "train")
        set_flat(self.model, self.keys, g)
        t0 = time.time()
        loss = train_local(self.model, X, Y, epochs=int(cfg["epochs"]), lr=float(cfg["lr"]),
                           batch_size=int(cfg["batch_size"]), device=self.device, seed=r * 1000 + self.id)
        train_s = time.time() - t0
        self._save_local()  # keeps this hospital's BatchNorm statistics (FedBN)
        delta = get_flat(self.model, self.keys) - g

        # 2. Clip + int8 quantisation (or a poisoning attempt)
        attacking = self._attacking(r)
        if attacking and self.attack == "boost":
            # Model-poisoning: scale the update up and skip clipping.
            q = quant.quantize(delta * self.boost_factor * (clip_norm / max(np.linalg.norm(delta), 1e-12)),
                               scale, self.rng)
        else:
            q = quant.quantize(quant.clip(delta, clip_norm), scale, self.rng, bound)
        n = int(len(X))

        # 3. Commitment (Poseidon, inside the circuit's witness generator)
        chunks = quant.to_chunks(q, n_chunk)
        salts = zk.new_salts(len(chunks))
        ctx = ctx_for(r, self.id, ghash)
        t0 = time.time()
        commitments = zk.commit(ctx, chunks, salts, self.root)
        commit_s = time.time() - t0
        root = commitment_root(commitments)

        # 4. Secure-aggregation masking
        sent = q
        if attacking and self.attack == "tamper":
            # Commit/prove an honest update but upload a different (boosted) one.
            sent = np.clip(q * 20, -10**6, 10**6)
        peers = {int(pid): bytes.fromhex(pk) for pid, pk in zip(cfg["participants"], cfg["pubkeys"])
                 if int(pid) != self.id}
        y = secagg.mask_vector(sent * n, self.id, self.key, peers, r)

        with open(self._round_file(r), "w") as f:
            json.dump({"ctx": str(ctx), "salts": [str(s) for s in salts], "q": q.tolist(),
                       "chunk_size": n_chunk, "global_hash": cfg["global_hash"],
                       "participants": [int(p) for p in cfg["participants"]]}, f)
        # Only the commitment, the masked upload and the sample count leave the hospital.
        # (Loss and update norm stay local: they would leak information about the update.)
        print(f"[{self.name}] round {r}: loss {loss:.4f}, |delta| {np.linalg.norm(delta):.3f}, "
              f"train {train_s:.1f}s, commit {commit_s:.1f}s" + (f", ATTACK={self.attack}" if attacking else ""),
              flush=True)
        return {"config": {
            "hospital_id": self.id, "commitment_root": root.hex(),
            "masked_hash": secagg.masked_hash(y).hex(), "num_samples": n,
        }, "arrays": {"masked": y}}

    def _prove(self, cfg, arrays):
        r = int(cfg["round"])
        with open(self._round_file(r)) as f:
            st = json.load(f)
        seed = bytes.fromhex(cfg["seed"])
        q = np.asarray(st["q"], np.int64)
        chunks = quant.to_chunks(q, int(st["chunk_size"]))
        xs = [x_for(seed, k) for k in range(len(chunks))]
        t0 = time.time()
        out = zk.prove(int(st["ctx"]), xs, chunks, [int(s) for s in st["salts"]], self.root)
        return {"config": {"hospital_id": self.id, "proofs": json.dumps(out["proofs"]),
                           "prove_seconds": round(time.time() - t0, 2)}, "arrays": {}}

    def _unmask(self, cfg, arrays):
        r = int(cfg["round"])
        excluded = [int(e) for e in cfg["excluded"]]
        with open(self._round_file(r)) as f:
            st = json.load(f)
        participants = st["participants"]
        survivors = [p for p in participants if p not in excluded]
        min_survivors = int(cfg.get("min_survivors", 2))
        if len(survivors) < min_survivors:
            raise PermissionError(f"refusing to unmask: only {len(survivors)} survivors (< {min_survivors}); "
                                  "my update would be exposed")
        # Do not take the aggregator's word for it: check the public ledger.
        if self.trust_url:
            info = requests.get(f"{self.trust_url}/api/rounds/{r}", timeout=30).json()
            status = {int(s["hospitalId"]): s["status"] for s in info.get("submissions", [])}
            for e in excluded:
                if status.get(e) == "accepted":
                    raise PermissionError(f"hospital {e} is accepted on the ledger; will not reveal its mask seed")
        peers = {int(p): bytes.fromhex(pk) for p, pk in zip(cfg["participants"], cfg["pubkeys"])}
        seeds = {}
        for e in excluded:
            if e == self.id or e not in participants:
                continue
            seeds[str(e)] = secagg.pairwise_seed(self.key, self.id, e, peers[e], r).hex()
        return {"config": {"hospital_id": self.id, "seeds": seeds}, "arrays": {}}

    def _evaluate(self, cfg, arrays):
        g = np.asarray(arrays["global"], np.float32)
        set_flat(self.model, self.keys, g)
        Xtr, _ = load_hospital(self.data_dir, self.id, "train")
        recalibrate_bn(self.model, Xtr, device=self.device)
        self._save_local()
        X, Y = load_hospital(self.data_dir, self.id, "val")
        m = evaluate(self.model, X, Y, device=self.device)
        return {"config": {"hospital_id": self.id, **m}, "arrays": {}}

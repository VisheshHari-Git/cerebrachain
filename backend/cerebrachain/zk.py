"""Python wrapper around the Node.js prover (zk/prover.js)."""
from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import tempfile

import numpy as np

from .fields import R

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def project_root() -> str:
    return os.environ.get("CEREBRA_ROOT", PROJECT_ROOT)


def build_dir(root: str | None = None) -> str:
    return os.path.join(root or project_root(), "zk", "build")


def chunk_size(root: str | None = None) -> int:
    with open(os.path.join(build_dir(root), "meta.json")) as f:
        return int(json.load(f)["chunkSize"])


def new_salts(k: int) -> list[int]:
    return [secrets.randbelow(R) for _ in range(k)]


def _run(cmd: str, payload: dict, root: str | None) -> dict:
    root = root or project_root()
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node is not on PATH; the prover needs Node.js >= 18")
    with tempfile.TemporaryDirectory(prefix="cerebra-zk-") as tmp:
        fin, fout = os.path.join(tmp, "in.json"), os.path.join(tmp, "out.json")
        with open(fin, "w") as f:
            json.dump(payload, f)
        env = dict(os.environ, CEREBRA_ZK_BUILD=build_dir(root))
        res = subprocess.run([node, os.path.join(root, "zk", "prover.js"), cmd, fin, fout],
                             capture_output=True, text=True, env=env)
        if res.returncode != 0:
            raise RuntimeError(f"prover {cmd} failed:\n{res.stderr[-2000:]}")
        with open(fout) as f:
            return json.load(f)


def _chunks_json(chunks: list[np.ndarray]) -> list[list[int]]:
    return [[int(v) for v in c] for c in chunks]


def commit(ctx: int, chunks: list[np.ndarray], salts: list[int], root: str | None = None) -> list[int]:
    out = _run("commit", {"ctx": str(ctx), "chunks": _chunks_json(chunks), "salts": [str(s) for s in salts]}, root)
    return [int(c) for c in out["commitments"]]


def prove(ctx: int, xs: list[int], chunks: list[np.ndarray], salts: list[int], root: str | None = None) -> dict:
    return _run("prove", {"ctx": str(ctx), "xs": [str(x) for x in xs], "chunks": _chunks_json(chunks),
                          "salts": [str(s) for s in salts]}, root)

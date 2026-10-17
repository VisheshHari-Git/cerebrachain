"""End-to-end protocol test: real training, real Groth16 proofs, real trust layer
(without blockchain), three in-process hospitals. Takes a few minutes on a laptop.

    python -m pytest -q tests/test_e2e.py
"""
import os
import socket
import subprocess
import time

import numpy as np
import pytest
import requests

from cerebrachain.aggregator import Aggregator, FedConfig
from cerebrachain.hospital import Hospital
from cerebrachain.local_run import LocalTransport
from cerebrachain.zk import chunk_size

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
pytestmark = pytest.mark.skipif(not os.path.exists(os.path.join(ROOT, "zk/build/update_chunk.zkey")),
                                reason="run scripts/zk_setup.sh first")


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def trust_url(tmp_path_factory):
    port = _free_port()
    storage = tmp_path_factory.mktemp("storage")
    env = dict(os.environ, PORT=str(port), CHAIN="off", STORAGE_DIR=str(storage))
    proc = subprocess.Popen(["node", os.path.join(ROOT, "trust-layer/src/server.js")], env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f"http://127.0.0.1:{port}"
    for _ in range(60):
        try:
            requests.get(url + "/api/health", timeout=1)
            break
        except requests.ConnectionError:
            time.sleep(0.5)
    yield url
    proc.terminate()


@pytest.fixture(scope="module")
def data_dir(tmp_path_factory):
    d = tmp_path_factory.mktemp("data")
    from cerebrachain.data import main as make_data
    make_data(["--hospitals", "3", "--out", str(d), "--slices-per-hospital", "40"])
    return str(d)


def _run(trust_url, data_dir, work, attack="none"):
    hospitals = {i: Hospital(i, data_dir, str(work), device="cpu", trust_url=trust_url,
                             attack=attack if i == 2 else "none") for i in range(3)}
    cfg = FedConfig(rounds=1, epochs=1, trust_url=trust_url)
    agg = Aggregator(cfg, LocalTransport(hospitals, workers=3), chunk_size(), log=lambda m: None)
    g0 = agg.g.copy()
    hist = agg.run()
    state = requests.get(trust_url + "/api/state").json()
    rd = state["rounds"][str(hist[0]["round"])]
    return agg, g0, hist[0], rd


def test_honest_round_updates_model(trust_url, data_dir, tmp_path):
    agg, g0, res, rd = _run(trust_url, data_dir, tmp_path / "honest")
    assert res["updated"]
    assert rd["aggregateCheck"]["passed"]
    assert all(s["status"] == "accepted" for s in rd["submissions"].values())
    assert not np.allclose(agg.g, g0)


def test_poisoned_update_is_rejected_and_round_still_completes(trust_url, data_dir, tmp_path):
    agg, g0, res, rd = _run(trust_url, data_dir, tmp_path / "boost", attack="boost")
    assert rd["submissions"]["2"]["status"] == "rejected"
    assert "norm exceeds bound" in rd["submissions"]["2"]["reason"]
    assert res["updated"] and rd["aggregateCheck"]["passed"]      # survivors unmasked correctly


def test_tampered_upload_aborts_round(trust_url, data_dir, tmp_path):
    agg, g0, res, rd = _run(trust_url, data_dir, tmp_path / "tamper", attack="tamper")
    assert all(s["status"] == "accepted" for s in rd["submissions"].values())  # proofs were honest...
    assert not res["updated"]                                                   # ...but the upload was not
    assert not rd["aggregateCheck"]["passed"]
    assert np.allclose(agg.g, g0)

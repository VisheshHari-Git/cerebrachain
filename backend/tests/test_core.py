"""Fast unit tests (no ZK proving, no network)."""
import json
import os
import subprocess

import numpy as np
import pytest

from cerebrachain import fields, quant, secagg
from cerebrachain.model import build_model, federated_keys, get_flat, model_hash, set_flat

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_python_and_js_hashing_agree():
    """fields.py and trust-layer/src/protocol.js must derive identical ctx/seed/x/root."""
    gh = bytes(range(32))
    roots = [bytes([i]) * 32 for i in range(3)]
    masks = [bytes([0xA0 + i]) * 32 for i in range(3)]
    entries = [(i, roots[i], masks[i], 100 + i) for i in range(3)]
    commitments = [12345, fields.R - 1, 2**200 + 7]

    py = {
        "ctx": str(fields.ctx_for(7, 2, gh)),
        "seed": "0x" + fields.challenge_seed(7, gh, entries).hex(),
        "x": str(fields.x_for(fields.challenge_seed(7, gh, entries), 5)),
        "root": "0x" + fields.commitment_root(commitments).hex(),
    }
    js_src = f"""
    const P = require({json.dumps(os.path.join(ROOT, "trust-layer/src/protocol.js"))});
    const gh = "0x{gh.hex()}";
    const entries = {json.dumps([{"hospitalId": i, "commitmentRoot": "0x" + r.hex(), "maskedHash": "0x" + m.hex(),
                                  "numSamples": n} for i, r, m, n in entries])};
    const seed = P.challengeSeed(7, gh, entries);
    console.log(JSON.stringify({{ctx: P.ctxFor(7, 2, gh).toString(), seed, x: P.xFor(seed, 5).toString(),
      root: P.commitmentRoot({json.dumps([str(c) for c in commitments])})}}));
    """
    out = subprocess.run(["node", "-e", js_src], capture_output=True, text=True, check=True).stdout
    assert json.loads(out) == py


def test_poly_eval_handles_negatives():
    x = 987654321
    vals = [3, -5, 0, 127, -128]
    expect = sum(v * pow(x, j, fields.R) for j, v in enumerate(vals)) % fields.R
    assert fields.poly_eval(vals, x) == expect


def test_quantize_is_unbiased_and_bounded():
    rng = np.random.default_rng(0)
    d = 5000
    delta = rng.normal(0, 1, d)
    C = 3.0
    s = quant.default_scale(C, d)
    B = quant.norm_bound(C, s, d)
    clipped = quant.clip(delta, C)
    assert np.linalg.norm(clipped) <= C + 1e-9
    qs = [quant.quantize(clipped, s, rng, B) for _ in range(30)]
    for q in qs:
        assert q.min() >= -128 and q.max() <= 127
        assert int((q * q).sum()) <= B
    mean = np.mean([quant.dequantize(q, s) for q in qs], axis=0)
    assert np.abs(mean - clipped).mean() < 0.2 * np.abs(clipped).mean()


def test_secure_aggregation_masks_cancel_and_unmask_works(tmp_path):
    rng = np.random.default_rng(1)
    ids = [0, 1, 2, 3]
    keys = {i: secagg.load_or_create_key(str(tmp_path / f"k{i}")) for i in ids}
    pubs = {i: secagg.public_bytes(keys[i]) for i in ids}
    vals = {i: rng.integers(-128, 128, 1000) * (50 + i) for i in ids}
    y = {i: secagg.mask_vector(vals[i], i, keys[i], {j: pubs[j] for j in ids if j != i}, round_id=3) for i in ids}

    # individual uploads look random
    assert abs(int(y[0].view(np.int64)[0])) > 10**12

    # all survive
    agg = secagg.aggregate(y, {})
    assert np.array_equal(agg, sum(vals.values()))

    # hospital 2 excluded -> survivors reveal their seed with 2
    survivors = [0, 1, 3]
    revealed = {(s, 2): secagg.pairwise_seed(keys[s], s, 2, pubs[2], 3) for s in survivors}
    agg = secagg.aggregate({s: y[s] for s in survivors}, revealed)
    assert np.array_equal(agg, vals[0] + vals[1] + vals[3])


def test_pairwise_seed_symmetric_and_round_specific(tmp_path):
    a, b = secagg.load_or_create_key(str(tmp_path / "a")), secagg.load_or_create_key(str(tmp_path / "b"))
    pa, pb = secagg.public_bytes(a), secagg.public_bytes(b)
    assert secagg.pairwise_seed(a, 0, 1, pb, 1) == secagg.pairwise_seed(b, 1, 0, pa, 1)
    assert secagg.pairwise_seed(a, 0, 1, pb, 1) != secagg.pairwise_seed(a, 0, 1, pb, 2)


def test_model_flatten_roundtrip_and_fedbn_keys():
    m = build_model(seed=0)
    keys = federated_keys(m)
    assert all("enc1.1." not in k for k in keys)            # BatchNorm stays local
    flat = get_flat(m, keys)
    h = model_hash(flat)
    set_flat(m, keys, flat + 1)
    assert model_hash(get_flat(m, keys)) != h
    set_flat(m, keys, flat)
    assert model_hash(get_flat(m, keys)) == h


@pytest.mark.parametrize("dim,n", [(1, 4096), (4096, 4096), (4097, 4096), (29377, 4096)])
def test_chunking(dim, n):
    q = np.arange(dim) % 200 - 100
    chunks = quant.to_chunks(q, n)
    assert len(chunks) == quant.num_chunks(dim, n)
    assert np.array_equal(np.concatenate(chunks)[:dim], q)
    assert not np.concatenate(chunks)[dim:].any()

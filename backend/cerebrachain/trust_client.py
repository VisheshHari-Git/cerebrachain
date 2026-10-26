"""HTTP client for the trust layer (trust-layer/src/server.js)."""
from __future__ import annotations

import requests


class TrustLayerError(RuntimeError):
    pass


class TrustClient:
    def __init__(self, url: str, timeout: float = 600):
        self.url = url.rstrip("/")
        self.timeout = timeout

    def _post(self, path, body):
        r = requests.post(f"{self.url}{path}", json=body, timeout=self.timeout)
        if r.status_code >= 400:
            raise TrustLayerError(f"POST {path} -> {r.status_code}: {r.text[:500]}")
        return r.json()

    def _get(self, path):
        r = requests.get(f"{self.url}{path}", timeout=self.timeout)
        if r.status_code >= 400:
            raise TrustLayerError(f"GET {path} -> {r.status_code}: {r.text[:500]}")
        return r.json()

    def health(self):
        return self._get("/api/health")

    def reset(self):
        return self._post("/api/reset", {})

    def register_hospital(self, **kw):
        return self._post("/api/hospitals", kw)

    def open_round(self, **kw):
        return self._post("/api/rounds", kw)

    def commit(self, r, **kw):
        return self._post(f"/api/rounds/{r}/commits", kw)

    def close_commits(self, r):
        return self._post(f"/api/rounds/{r}/close-commits", {})

    def submit_proofs(self, r, **kw):
        return self._post(f"/api/rounds/{r}/proofs", kw)

    def mark_missing(self, r, hospital_id, reason):
        return self._post(f"/api/rounds/{r}/missing", {"hospitalId": hospital_id, "reason": reason})

    def finalize(self, r, **kw):
        return self._post(f"/api/rounds/{r}/finalize", kw)

    def metrics(self, r, **kw):
        return self._post(f"/api/rounds/{r}/metrics", kw)

    def initial_metrics(self, **kw):
        return self._post("/api/initial-metrics", kw)

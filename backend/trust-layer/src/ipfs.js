"use strict";
/**
 * Content-addressed storage with real IPFS CIDs.
 *
 * Every blob is stored under its CIDv1 (raw codec, sha2-256), the same CID an
 * IPFS node assigns to a single-block file added with --cid-version=1 --raw-leaves.
 * Blobs are always kept in storage/ipfs/<cid>. If IPFS_API is set (e.g.
 * http://127.0.0.1:5001 for a local Kubo node) they are also added and pinned there.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32(bytes) {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function cidV1Raw(data) {
  const digest = crypto.createHash("sha256").update(data).digest();
  // <cidv1><raw codec 0x55><sha2-256 0x12><len 32><digest>
  return "b" + base32(Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]));
}

class ContentStore {
  constructor(dir, apiUrl) {
    this.dir = dir;
    this.apiUrl = apiUrl || null;
    fs.mkdirSync(dir, { recursive: true });
  }

  async put(data, name = "blob") {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === "string" ? data : JSON.stringify(data));
    let cid = cidV1Raw(buf);
    fs.writeFileSync(path.join(this.dir, cid), buf);
    let pinned = false;
    if (this.apiUrl) {
      try {
        const form = new FormData();
        form.append("file", new Blob([buf]), name);
        const res = await fetch(`${this.apiUrl}/api/v0/add?cid-version=1&raw-leaves=true&pin=true`, {
          method: "POST",
          body: form,
        });
        const j = await res.json();
        pinned = true;
        if (j.Hash && j.Hash !== cid) {
          // Large files are chunked by IPFS into a DAG; keep the node's CID as the canonical one.
          fs.writeFileSync(path.join(this.dir, j.Hash), buf);
          cid = j.Hash;
        }
      } catch (e) {
        console.warn(`[ipfs] could not pin to ${this.apiUrl}: ${e.message}`);
      }
    }
    return { cid, size: buf.length, pinned };
  }

  get(cid) {
    if (!/^[a-z2-7]+$/.test(cid.slice(1)) && !/^Qm[1-9A-HJ-NP-Za-km-z]+$/.test(cid)) return null;
    const p = path.join(this.dir, cid);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  }
}

module.exports = { ContentStore, cidV1Raw };

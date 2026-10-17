pragma circom 2.1.6;

include "../../node_modules/circomlib/circuits/poseidon.circom";
include "../../node_modules/circomlib/circuits/bitify.circom";

/*
 * UpdateChunk(N)
 *
 * Proves facts about one N-element chunk of a hospital's quantized model update
 * without revealing the update itself.
 *
 * Private inputs
 *   q[N]   quantized update values, each an int8 in [-128, 127]
 *   salt   random field element that makes the commitment hiding
 *
 * Public inputs
 *   ctx    binds the proof to (round, hospital id, global model hash)
 *   x      Fiat-Shamir challenge for this chunk, derived only after every
 *          hospital has fixed its commitment and its masked upload
 *
 * Public outputs
 *   commitment  Poseidon commitment to (ctx, salt, q)
 *   evalAtX     sum_j q[j] * x^j  (the chunk as a polynomial, evaluated at x)
 *   sumSq       sum_j q[j]^2      (squared L2 norm of the chunk)
 *
 * The verifier adds up sumSq over all chunks to enforce the norm bound, and uses
 * evalAtX to check that the secure-aggregation sum really is the sum of the
 * committed updates (Schwartz-Zippel: a wrong aggregate passes with probability
 * at most N / p).
 *
 * publicSignals order (snarkjs): [commitment, evalAtX, sumSq, ctx, x]
 */
template UpdateChunk(N) {
    signal input ctx;
    signal input x;
    signal input q[N];
    signal input salt;

    signal output commitment;
    signal output evalAtX;
    signal output sumSq;

    // ---- 1. Range check: every q[j] is an int8 (q + 128 fits in 8 bits) ----
    component bits[N];
    for (var j = 0; j < N; j++) {
        bits[j] = Num2Bits(8);
        bits[j].in <== q[j] + 128;
    }

    // ---- 2. Squared L2 norm ----
    signal sq[N];
    var acc = 0;
    for (var j = 0; j < N; j++) {
        sq[j] <== q[j] * q[j];
        acc += sq[j];
    }
    sumSq <== acc;

    // ---- 3. Polynomial evaluation at x (Horner, one constraint per element) ----
    signal horner[N + 1];
    horner[N] <== 0;
    for (var j = N - 1; j >= 0; j--) {
        horner[j] <== horner[j + 1] * x + q[j];
    }
    evalAtX <== horner[0];

    // ---- 4. Commitment: pack 31 bytes per field element, Poseidon sponge ----
    var PER = 31;                       // 31 * 8 = 248 bits < 254-bit field
    var P = (N + PER - 1) \ PER;        // number of packed field elements
    signal packed[P];
    for (var i = 0; i < P; i++) {
        var lc = 0;
        var pw = 1;
        for (var k = 0; k < PER; k++) {
            var j = i * PER + k;
            if (j < N) {
                lc += (q[j] + 128) * pw;
                pw *= 256;
            }
        }
        packed[i] <== lc;
    }

    var RATE = 15;                      // Poseidon(16): 1 state + 15 data
    var B = (P + RATE - 1) \ RATE;      // number of absorb steps
    component init = Poseidon(2);
    init.inputs[0] <== ctx;
    init.inputs[1] <== salt;

    component absorb[B];
    for (var b = 0; b < B; b++) {
        absorb[b] = Poseidon(16);
        if (b == 0) {
            absorb[b].inputs[0] <== init.out;
        } else {
            absorb[b].inputs[0] <== absorb[b - 1].out;
        }
        for (var k = 0; k < RATE; k++) {
            var i = b * RATE + k;
            if (i < P) {
                absorb[b].inputs[k + 1] <== packed[i];
            } else {
                absorb[b].inputs[k + 1] <== 0;
            }
        }
    }
    commitment <== absorb[B - 1].out;
}

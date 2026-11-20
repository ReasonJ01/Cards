// RWKV-Instant SM98 browser inference. Port of JSchoreels/anki's RWKV runner.
// Copyright Ankitects Pty Ltd and contributors; modifications Bloom contributors.
// SPDX-License-Identifier: AGPL-3.0-or-later. See RWKV-NOTICE.md.
const sigmoid = x => 1 / (1 + Math.exp(-x));
const map = (x, fn) => Float32Array.from(x, fn);
const add = (a, b) => map(a, (v, i) => v + b[i]);

export class RWKV {
  constructor(bytes, spec) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let pos = 0;
    const text = n => { if (pos + n > data.length) throw Error('Truncated RWKV model'); const s = new TextDecoder().decode(data.subarray(pos, pos + n)); pos += n; return s };
    const u8 = () => view.getUint8(pos++);
    const u16 = () => { const n = view.getUint16(pos, true); pos += 2; return n };
    const u32 = () => { const n = view.getUint32(pos, true); pos += 4; return n };
    if (text(13) !== 'ARWKVWEIGHTS1') throw Error('Invalid RWKV model');
    this.weights = new Map();
    const count = u32();
    for (let i = 0; i < count; i++) {
      const name = text(u16()), rank = u8(), shape = Array.from({ length: rank }, u32);
      const length = shape.reduce((a, b) => a * b, 1);
      if (!Number.isSafeInteger(length) || length > (data.length - pos) / 4) throw Error('Invalid RWKV tensor');
      const values = new Float32Array(length);
      for (let j = 0; j < length; j++, pos += 4) values[j] = view.getFloat32(pos, true);
      this.weights.set(name, { shape, values });
    }
    if (pos !== data.length || spec.d_model !== 64) throw Error('Unsupported RWKV model');
    this.spec = spec;
    this.states = Array.from({ length: 5 }, () => new Map());
  }
  w(name) { const t = this.weights.get(name); if (!t) throw Error('Missing RWKV weight: ' + name); return t.values }
  linear(name, x) {
    const t = this.weights.get(name + '.weight');
    if (!t || t.shape[1] !== x.length) throw Error('Invalid RWKV layer: ' + name);
    const out = new Float32Array(t.shape[0]), bias = this.weights.get(name + '.bias')?.values;
    for (let i = 0; i < out.length; i++) {
      let sum = bias?.[i] || 0;
      for (let j = 0; j < x.length; j++) sum += t.values[i * x.length + j] * x[j];
      out[i] = sum;
    }
    return out;
  }
  norm(name, x, groups = 1, eps = 1e-5) {
    const w = this.w(name + '.weight'), b = this.w(name + '.bias'), out = new Float32Array(x.length), size = x.length / groups;
    for (let g = 0; g < groups; g++) {
      const start = g * size; let mean = 0, variance = 0;
      for (let j = 0; j < size; j++) mean += x[start + j] / size;
      for (let j = 0; j < size; j++) variance += (x[start + j] - mean) ** 2 / size;
      const scale = 1 / Math.sqrt(variance + eps);
      for (let j = 0; j < size; j++) { const i = start + j; out[i] = (x[i] - mean) * scale * w[i] + b[i] }
    }
    return out;
  }
  lora(name, x, tanh = false) {
    let h = this.linear(name + '.A', x);
    if (tanh) h = map(h, Math.tanh);
    const out = this.linear(name + '.B_and_lamb', h);
    return tanh ? out : map(out, sigmoid);
  }
  layer(module, layer, input, v0, prev) {
    const prefix = `rwkv_modules.${module}.blocks.${layer}`, t = prefix + '.time_mixer';
    const x = this.norm(t + '.layer_norm', input), shift = prev?.x || x, lerp = this.w(t + '.rkvdag_lerp');
    const mix = part => map(x, (v, i) => v + (shift[i] - v) * lerp[part * 64 + i]);
    const r = this.linear(t + '.W_r', mix(0)), k = this.linear(t + '.W_k', mix(1));
    const ks = map(this.linear(t + '.k_scale_linear', mix(6)), sigmoid), vs = map(this.linear(t + '.v_scale_linear', mix(7)), sigmoid);
    let v = this.linear(t + '.W_v', mix(2));
    if (layer === 0) v0 = v.slice();
    else { const blend = this.lora(t + '.v_lora_simple', mix(2)); v = map(v, (z, i) => z + (v0[i] - z) * blend[i]) }
    const a = this.lora(t + '.a_lora_simple', mix(4));
    const gate = this.linear(t + '.lora_B_g', map(this.linear(t + '.lora_A_g', mix(5)), sigmoid));
    const decay = map(this.lora(t + '.d_lora_mlp', mix(3), true), z => Math.exp(-Math.exp(-0.5 - Math.log1p(Math.exp(-z)))));
    for (let h = 0; h < 4; h++) {
      let kn = 0, vn = 0;
      for (let j = 0; j < 16; j++) { kn += k[h * 16 + j] ** 2; vn += v[h * 16 + j] ** 2 }
      kn = Math.max(Math.sqrt(kn), 1e-12); vn = Math.max(Math.sqrt(vn), 1e-12);
      for (let j = 0; j < 16; j++) { const i = h * 16 + j; k[i] *= ks[h] / kn; v[i] *= vs[h] / vn }
    }
    const kd = k.slice();
    for (let i = 0; i < 64; i++) k[i] *= a[i];
    const matrix = new Float32Array(1024), out = new Float32Array(64), old = prev?.matrix;
    for (let h = 0; h < 4; h++) for (let row = 0; row < 16; row++) {
      const start = h * 256 + row * 16; let dot = 0;
      for (let j = 0; j < 16; j++) dot += (old?.[start + j] || 0) * kd[h * 16 + j];
      for (let col = 0; col < 16; col++) {
        const i = h * 16 + col;
        matrix[start + col] = (old?.[start + col] || 0) * decay[i] - dot * a[i] * kd[i] + v[h * 16 + row] * k[i];
        out[h * 16 + row] += matrix[start + col] * r[i];
      }
    }
    let normalized = this.norm(t + '.out_group_norm', out, 4, 0.00064);
    const bonus = this.w(t + '.bonus');
    for (let h = 0; h < 4; h++) {
      let scale = 0;
      for (let j = 0; j < 16; j++) { const i = h * 16 + j; scale += r[i] * bonus[i] * k[i] }
      for (let j = 0; j < 16; j++) { const i = h * 16 + j; normalized[i] = gate[i] * (normalized[i] + scale * v[i]) }
    }
    let result = add(input, this.linear(t + '.W_o', normalized)), channel;
    const c = prefix + '.channel_mixer';
    if (!this.spec.streams[module].channel_mixer_stripped_layers?.includes(layer)) {
      channel = this.norm(c + '.layer_norm', result);
      const cs = prev?.channel || channel, blend = this.w(c + '.lerp_k');
      const hidden = this.linear(c + '.W_k', map(channel, (z, i) => z + (cs[i] - z) * blend[i]));
      result = add(result, this.linear(c + '.W_v', map(hidden, z => Math.max(0, z) ** 2)));
    }
    return { result, v0, state: { x, matrix, channel } };
  }
  run(features, ids, commit = false) {
    if (features.length !== 92 || ids.length !== 5) throw Error('Invalid RWKV inputs');
    const f = Float32Array.from(features); f[13] = f[14] = f[15] = f[22] = 0;
    const silu = z => z * sigmoid(z);
    let x = map(this.linear('features2card.0', f), silu);
    x = map(this.linear('features2card.3', this.norm('features2card.2', x)), silu);
    const v0 = [], next = Array.from({ length: 5 }, () => []);
    for (const [m, l] of this.spec.layer_steps) {
      const step = this.layer(m, l, x, v0[m], this.states[m].get(ids[m])?.[l]);
      x = step.result; v0[m] = step.v0; next[m][l] = step.state;
    }
    const logits = this.linear('p_linear', map(this.linear('head_p.0', this.norm('prehead_norm', x)), z => Math.max(0, z)));
    const max = Math.max(...logits), exp = Array.from(logits, z => Math.exp(z - max)), sum = exp.reduce((a, b) => a + b);
    if (commit) for (let m = 0; m < 5; m++) this.states[m].set(ids[m], next[m]);
    return exp.map(z => z / sum);
  }
}

'use strict';

const $ = id => document.getElementById(id);
const val = id => {
  const e = $(id);
  if (!e || typeof e.value !== 'string' || e.value.trim() === '') return NaN;
  const v = Number(e.value);
  return Number.isFinite(v) ? v : NaN;
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = (v, d = 2) => Number.isFinite(v) ? v.toLocaleString('ko-KR', { maximumFractionDigits: d }) : '—';
const ms = v => v >= 1000 ? `${fmt(v / 1000, 2)} s` : `${fmt(v, 1)} ms`;
const pct = v => `${fmt(v * 100, 1)}%`;
const mb = v => `${fmt(v * 1000, 1)} MB`;
const EPS = 1e-12;

function rng(seed) {
  const mask64 = (1n << 64n) - 1n;
  let state = BigInt(seed) & mask64;
  return () => {
    state = (state + 0x9E3779B97F4A7C15n) & mask64;
    let value = state;
    value = ((value ^ (value >> 30n)) * 0xBF58476D1CE4E5B9n) & mask64;
    value = ((value ^ (value >> 27n)) * 0x94D049BB133111EBn) & mask64;
    value ^= value >> 31n;
    return Number(value >> 11n) / 9007199254740992;
  };
}
function stochasticRound(x, r) {
  const a = Math.floor(x);
  return a + (r() < x - a ? 1 : 0);
}

class LRU {
  constructor(cap) {
    this.cap = Math.max(0, cap | 0);
    this.m = new Map();
    this.ev = 0;
  }
  has(k) { return this.m.has(k); }
  get(k) {
    if (!this.m.has(k)) return false;
    this.m.delete(k);
    this.m.set(k, 1);
    return true;
  }
  put(k) {
    let evicted = null;
    if (!this.cap) return evicted;
    if (this.m.has(k)) this.m.delete(k);
    else if (this.m.size >= this.cap) {
      evicted = this.m.keys().next().value;
      this.m.delete(evicted);
      this.ev++;
    }
    this.m.set(k, 1);
    return evicted;
  }
  delete(k) { return this.m.delete(k); }
  deleteOldest() {
    if (!this.m.size) return null;
    const k = this.m.keys().next().value;
    this.m.delete(k);
    this.ev++;
    return k;
  }
  get size() { return this.m.size; }
}

class StorageResource {
  constructor(c) {
    this.c = c;
    this.free = 0;
    this.gb = 0;
    this.busy = 0;
    this.queue = 0;
    this.byKind = Object.create(null);
    this.events = [];
  }
  reserveGB(gb, now, kind, requests = 1, bwRatio = 1) {
    if (!(gb > 0)) return { start: now, end: now, service: 0, gb: 0, wait: 0, kind };
    const start = Math.max(now, this.free);
    const qd = Math.max(1, this.c.qd || 1);
    const waves = Math.ceil(Math.max(1, requests) / qd);
    const bw = Math.max(EPS, this.c.ssdBW * Math.max(EPS, bwRatio));
    const service = waves * this.c.lat / 1000 + gb / bw * 1000;
    const end = start + service;
    this.free = end;
    this.gb += gb;
    this.busy += service;
    this.queue += start - now;
    this.byKind[kind] = (this.byKind[kind] || 0) + gb;
    const event = { start, end, service, gb, wait: start - now, kind };
    this.events.push(event);
    return event;
  }
}

function snapshotStorageResource(resource) {
  return {
    free: resource.free,
    gb: resource.gb,
    busy: resource.busy,
    queue: resource.queue,
    byKind: { ...resource.byKind },
    events: resource.events.map(event => ({ ...event }))
  };
}

function restoreStorageResource(resource, snapshot) {
  resource.free = snapshot.free;
  resource.gb = snapshot.gb;
  resource.busy = snapshot.busy;
  resource.queue = snapshot.queue;
  resource.byKind = Object.assign(Object.create(null), snapshot.byKind);
  resource.events = snapshot.events.map(event => ({ ...event }));
}

function summarizeStorageEvents(events) {
  const byKind = new Map();
  for (const event of events || []) {
    const summary = byKind.get(event.kind) || { kind: event.kind, start: event.start, end: event.end, service: 0, gb: 0, wait: 0, jobs: 0 };
    summary.start = Math.min(summary.start, event.start);
    summary.end = Math.max(summary.end, event.end);
    summary.service += event.service;
    summary.gb += event.gb;
    summary.wait += event.wait;
    summary.jobs += Number.isInteger(event.jobs) ? event.jobs : 1;
    byKind.set(event.kind, summary);
  }
  return [...byKind.values()];
}

class LinkResource {
  constructor(c) {
    this.c = c;
    this.free = 0;
    this.gb = 0;
  }
  reserveGB(gb, now) {
    if (!(gb > 0) || this.c.arch === 'unified') return { end: now, service: 0, gb: 0, wait: 0 };
    const bw = Math.max(EPS, Math.min(this.c.pcieBW, this.c.dramBW));
    const start = Math.max(now, this.free);
    const service = gb / bw * 1000;
    const end = start + service;
    this.free = end;
    this.gb += gb;
    return { start, end, service, gb, wait: start - now };
  }
}

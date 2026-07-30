
// ================================  *
//   Copyright Xialia.com  2013-2026 *
//   FILE  : memory-watch.js
//   TYPE  : module
// ================================  *

const { env } = process;

const MB = 1024 * 1024;
const STOPPED_CAP = 10000;

/**
 *
 * @param {*} name
 * @param {*} fallback
 * @returns
 */
function intEnv(name, fallback) {
  let v = parseInt(env[name]);
  if (isNaN(v) || v < 0) return fallback;
  return v;
}

/**
 *
 * @returns
 */
function now() {
  return new Date().toISOString();
}

class MemoryWatch {
  constructor() {
    this.enabled = env.MEMWATCH !== '0';
    this.tracking = this.enabled
      && env.MEMWATCH_TRACK !== '0'
      && typeof FinalizationRegistry === 'function'
      && typeof WeakRef === 'function';
    this.interval = intEnv('MEMWATCH_INTERVAL', 60);
    this.window = Math.max(intEnv('MEMWATCH_WINDOW', 15), 3);
    this.growthMb = intEnv('MEMWATCH_GROWTH_MB', 64);
    this.rssMaxMb = intEnv('MEMWATCH_RSS_MAX_MB', 1024);
    this.zombieAge = intEnv('MEMWATCH_ZOMBIE_AGE', 300);
    this.zombieMax = intEnv('MEMWATCH_ZOMBIE_MAX', 200);
    this.cooldown = intEnv('MEMWATCH_COOLDOWN', 1800);

    this.samples = [];
    this.classes = new Map();
    this.stopped = new Set();
    this.lastWarn = {};
    this.timer = null;
    if (this.tracking) {
      this.registry = new FinalizationRegistry((name) => {
        let c = this.classes.get(name);
        if (c) c.finalized++;
      });
    }
  }

  /**
   *
   * @param {*} obj
   * @returns
   */
  track(obj) {
    if (!this.tracking) return;
    let name = obj.constructor.name || 'anonymous';
    let c = this.classes.get(name);
    if (!c) {
      c = { created: 0, finalized: 0 };
      this.classes.set(name, c);
    }
    c.created++;
    this.registry.register(obj, name);
  }

  /**
   *
   * @param {*} obj
   * @returns
   */
  markStopped(obj) {
    if (!this.tracking) return;
    if (this.stopped.size >= STOPPED_CAP) {
      let oldest = this.stopped.values().next().value;
      this.stopped.delete(oldest);
    }
    this.stopped.add({
      ref: new WeakRef(obj),
      name: obj.constructor.name || 'anonymous',
      time: Date.now(),
    });
  }

  /**
   *
   * @param {*} limit
   * @returns
   */
  topLive(limit = 5) {
    let rows = [];
    for (let [name, c] of this.classes) {
      let live = c.created - c.finalized;
      if (live > 0) rows.push({ name, live });
    }
    rows.sort((a, b) => b.live - a.live);
    return rows.slice(0, limit);
  }

  /**
   *
   * @returns
   */
  zombies() {
    let res = new Map();
    let limit = Date.now() - this.zombieAge * 1000;
    for (let item of this.stopped) {
      if (!item.ref.deref()) {
        this.stopped.delete(item);
        continue;
      }
      if (item.time < limit) {
        res.set(item.name, (res.get(item.name) || 0) + 1);
      }
    }
    return res;
  }

  /**
   *
   * @param {*} kind
   * @param  {...any} args
   * @returns
   */
  warn(kind, ...args) {
    let last = this.lastWarn[kind] || 0;
    if (Date.now() - last < this.cooldown * 1000) return;
    this.lastWarn[kind] = Date.now();
    console.warn(`[${now()}] MemoryWatch[WARN]:`, ...args);
  }

  /**
   *
   * @returns
   */
  sample() {
    let m = process.memoryUsage();
    let s = {
      time: Date.now(),
      rss: m.rss,
      heapUsed: m.heapUsed,
      heapTotal: m.heapTotal,
      external: m.external,
      used: m.heapUsed + m.external,
    };
    this.samples.push(s);
    if (this.samples.length > this.window) this.samples.shift();

    if (this.rssMaxMb && s.rss > this.rssMaxMb * MB) {
      this.warn('rss',
        `rss ${(s.rss / MB).toFixed(1)}MB exceeds limit ${this.rssMaxMb}MB;`,
        `top live:`, this.format(this.topLive())
      );
    }

    if (this.samples.length === this.window) {
      let first = this.samples[0];
      let growth = s.used - first.used;
      let rising = 0;
      for (let i = 1; i < this.samples.length; i++) {
        if (this.samples[i].used > this.samples[i - 1].used) rising++;
      }
      let ratio = rising / (this.samples.length - 1);
      if (growth > this.growthMb * MB && ratio >= 0.85) {
        let hours = (s.time - first.time) / 3600000;
        let rate = hours > 0 ? (growth / MB / hours).toFixed(1) : 'n/a';
        this.warn('leak',
          `probable memory leak: heap+external grew ${(growth / MB).toFixed(1)}MB`,
          `over last ${this.samples.length} samples (~${rate}MB/h),`,
          `heapUsed=${(s.heapUsed / MB).toFixed(1)}MB`,
          `external=${(s.external / MB).toFixed(1)}MB`,
          `rss=${(s.rss / MB).toFixed(1)}MB;`,
          `top live:`, this.format(this.topLive())
        );
        this.samples = [s];
      }
    }

    if (this.tracking) {
      let z = this.zombies();
      let total = 0;
      for (let n of z.values()) total += n;
      if (total > this.zombieMax) {
        let rows = [...z.entries()]
          .sort((a, b) => b[1] - a[1]).slice(0, 5)
          .map(([name, n]) => `${name}:${n}`).join(' ');
        this.warn('zombie',
          `${total} components still retained ${this.zombieAge}s after stop();`,
          `top:`, rows
        );
      }
    }
    return s;
  }

  /**
   *
   * @param {*} rows
   * @returns
   */
  format(rows) {
    if (!rows.length) return 'n/a';
    return rows.map((r) => `${r.name}:${r.live}`).join(' ');
  }

  /**
   *
   * @returns
   */
  report() {
    let m = process.memoryUsage();
    return {
      enabled: this.enabled,
      tracking: this.tracking,
      rssMb: +(m.rss / MB).toFixed(1),
      heapUsedMb: +(m.heapUsed / MB).toFixed(1),
      samples: this.samples.length,
      topLive: this.topLive(10),
      stoppedPending: this.stopped.size,
    };
  }

  /**
   *
   * @returns
   */
  start() {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => this.sample(), this.interval * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  /**
   *
   * @returns
   */
  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

const instance = new MemoryWatch();
instance.start();

module.exports = instance;

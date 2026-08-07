'use strict';

class BigMoeByteLRU {
  constructor(capacityMiB) {
    this.capacityMiB = capacityMiB;
    this.usedMiB = 0;
    this.entries = new Map();
    this.evictions = 0;
  }

  access(key, sizeMiB) {
    if (this.entries.has(key)) {
      const size = this.entries.get(key);
      this.entries.delete(key);
      this.entries.set(key, size);
      return true;
    }
    if (!(this.capacityMiB > 0) || sizeMiB > this.capacityMiB) return false;
    while (this.usedMiB + sizeMiB > this.capacityMiB && this.entries.size) {
      const oldestKey = this.entries.keys().next().value;
      const oldestSize = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      this.usedMiB -= oldestSize;
      this.evictions++;
    }
    this.entries.set(key, sizeMiB);
    this.usedMiB += sizeMiB;
    return false;
  }
}

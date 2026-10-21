// Node's EventEmitter, as much of it as Ink and the terminal app use.
export class EventEmitter {
  #on = new Map();
  on(name, fn) {
    if (!this.#on.has(name)) this.#on.set(name, []);
    this.#on.get(name).push(fn);
    return this;
  }
  addListener(name, fn) {
    return this.on(name, fn);
  }
  prependListener(name, fn) {
    this.#on.set(name, [fn, ...(this.#on.get(name) ?? [])]);
    return this;
  }
  once(name, fn) {
    const once = (...args) => {
      this.off(name, once);
      fn.apply(this, args);
    };
    once.listener = fn;
    return this.on(name, once);
  }
  off(name, fn) {
    const list = this.#on.get(name);
    if (list) this.#on.set(name, list.filter((f) => f !== fn && f.listener !== fn));
    return this;
  }
  removeListener(name, fn) {
    return this.off(name, fn);
  }
  removeAllListeners(name) {
    if (name === undefined) this.#on.clear();
    else this.#on.delete(name);
    return this;
  }
  emit(name, ...args) {
    const list = this.#on.get(name);
    if (!list?.length) return false;
    for (const fn of [...list]) fn.apply(this, args);
    return true;
  }
  listeners(name) {
    return [...(this.#on.get(name) ?? [])];
  }
  listenerCount(name) {
    return this.#on.get(name)?.length ?? 0;
  }
  setMaxListeners() {
    return this;
  }
}
export default EventEmitter;

// Deterministic storage fixture, not evidence of Safari filesystem support.
// Playwright's ephemeral WebKit context on macOS rejects getDirectory().
export async function installOPFSFixture(context) {
  await context.addInitScript(() => {
    const entries = new Map();
    const directory = {
      async getFileHandle(name, { create = false } = {}) {
        if (!entries.has(name)) {
          if (!create) throw new DOMException("Missing", "NotFoundError");
          entries.set(name, { blob: new Blob() });
        }
        const entry = entries.get(name);
        return {
          async createWritable() {
            const parts = [];
            return {
              async write(bytes) { parts.push(bytes.slice()); },
              async close() { entry.blob = new Blob(parts); parts.length = 0; },
              async abort() { parts.length = 0; entries.delete(name); },
            };
          },
          async getFile() { return new File([entry.blob], name); },
        };
      },
      async removeEntry(name) { entries.delete(name); },
      async *entries() { yield* entries; },
    };
    Object.defineProperty(navigator, "storage", { configurable: true, value: {
      async getDirectory() { return { async getDirectoryHandle() { return directory; } }; },
      async estimate() { return { quota: 2 * 1024 ** 3, usage: [...entries.values()].reduce((n, e) => n + e.blob.size, 0) }; },
    } });
  });
}

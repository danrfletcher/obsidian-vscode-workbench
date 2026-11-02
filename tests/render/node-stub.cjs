// Stands in for Node's built-in modules in the browser bundle of tests/render/entry.mjs. The drawer's host page imports modules
// that use them for work the render check never runs; calling any of them here is a mistake and says so.
module.exports = new Proxy(
  {},
  {
    get: (_t, name) => {
      if (name === "__esModule") return false;
      return () => {
        throw new Error(`the render check does not run node:${String(name)}`);
      };
    },
  },
);

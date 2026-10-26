/** `.py` files are bundled as text (esbuild's text loader; a small plugin in vitest.config.mts). */
declare module "*.py" {
  const source: string;
  export default source;
}

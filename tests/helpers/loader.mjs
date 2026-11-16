/**
 * ESM resolve hook: redirect the bare `three` specifier (resolved via CDN
 * import map in the browser) to the local test stub.  Everything else keeps
 * the default Node resolution.
 */

const STUB_URL = new URL('./three-stub.js', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'three') {
    return { url: STUB_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

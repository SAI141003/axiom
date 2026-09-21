// satellite.js (MIT, vendored under lib/vendor/satellite without its WASM/
// worker build, which imports node:module and cannot be bundled for the
// browser). Pure-JS SGP4: the same propagator God's Eye View uses.
export { json2satrec, twoline2satrec, propagate, gstime, eciToGeodetic } from "./vendor/satellite/index.js";

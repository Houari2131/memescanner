#!/usr/bin/env node
// index.cjs (test minimal)
(async () => {
  try {
    await import('./index.js');
  } catch (err) {
    console.error('Shim error:', err);
    process.exit(1);
  }
})();

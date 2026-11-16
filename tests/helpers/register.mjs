import { register } from 'node:module';

// Provide an ImageData global on Node builds without canvas globals.
import { ensureImageData } from './image-data.js';
ensureImageData();

// Install the loader that stubs the browser-only bare `three` import before
// any production module is imported by the test files.
register(new URL('./loader.mjs', import.meta.url));

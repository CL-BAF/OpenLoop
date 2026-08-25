// Local plugin bundles must expose only plugin factory exports. The main module
// also exports LoopRuntime for tests and programmatic integration; exporting
// that class from a discovered plugin file makes OpenCode try to load it as a
// second plugin.
export {OpenLoopPlugin} from "./index.js";

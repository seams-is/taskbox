// What an engine's imageProblem says when the image isn't in its cache at all (v2.5.0): the loop
// downloads it again, where any other problem reads Failing. Its own module, so an engine (tart.ts)
// and the factory (vm.ts), which imports every engine, never import each other's values.
export const IMAGE_GONE = "the cached image has no manifest";

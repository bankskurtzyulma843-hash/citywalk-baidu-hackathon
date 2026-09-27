/**
 * Zoom handlers adapted from Mapus src/main.js:1178-1186.
 * Copyright (c) 2021 alyssaxuu. MIT License; see ./LICENSE.
 * Event binding is new; upstream zoomIn()/zoomOut() behavior is retained.
 */
export function bindMapusZoomControls(map, root = document) {
  function zoomIn() {
    map.zoomIn();
  }
  function zoomOut() {
    map.zoomOut();
  }
  const inward = root.querySelector('#zoom-in');
  const outward = root.querySelector('#zoom-out');
  inward?.addEventListener('click', zoomIn);
  outward?.addEventListener('click', zoomOut);
  return () => {
    inward?.removeEventListener('click', zoomIn);
    outward?.removeEventListener('click', zoomOut);
  };
}

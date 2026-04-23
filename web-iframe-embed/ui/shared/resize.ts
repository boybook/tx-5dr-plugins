/// <reference types="@tx5dr/plugin-api/bridge" />

export function installAutoResize(minHeight: number): void {
  const report = () => {
    const bodyHeight = document.body.scrollHeight;
    const nextHeight = Math.max(minHeight, bodyHeight);
    if (nextHeight > 0) {
      window.tx5dr.resize(nextHeight);
    }
  };

  const observer = new ResizeObserver(report);
  observer.observe(document.body);
  window.addEventListener('load', report, { once: true });
  window.addEventListener('resize', report);
  report();
}

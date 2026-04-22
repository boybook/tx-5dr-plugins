/// <reference types="@tx5dr/plugin-api/bridge" />
import { useEffect } from 'react';

export function useAutoResize() {
  useEffect(() => {
    const bridge = window.tx5dr;
    const report = () => {
      const height = document.body.scrollHeight;
      if (height > 0) {
        bridge.resize(height);
      }
    };

    const observer = new ResizeObserver(report);
    observer.observe(document.body);
    report();

    return () => observer.disconnect();
  }, []);
}

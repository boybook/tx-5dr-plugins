/// <reference types="@tx5dr/plugin-api/bridge" />
import { useEffect } from 'react';

export function useAutoResize() {
  useEffect(() => {
    const report = () => {
      const height = document.body.scrollHeight;
      if (height > 0) {
        window.tx5dr.resize(height);
      }
    };

    const observer = new ResizeObserver(report);
    observer.observe(document.body);
    report();

    return () => observer.disconnect();
  }, []);
}

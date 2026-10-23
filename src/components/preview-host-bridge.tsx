/**
 * Mount once in `__root.tsx` so the Grok preview chrome can drive navigation
 * (and later receive registered routes). Noops when the app is not embedded.
 *
 * The bridge module is loaded after the first paint so its parser is not on
 * the path that makes the bottom navigation respond.
 */

import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";

export function PreviewHostBridge() {
  const router = useRouter();

  useEffect(() => {
    let cancel = false;
    let dispose = () => {};
    const load = () => {
      void import("@/lib/preview-host-bridge").then((mod) => {
        if (cancel) return;
        dispose = mod.installPreviewHostBridge({
          navigate: (path) => {
            router.history.push(path);
          },
          getRoutePaths: () => mod.collectRoutePathsFromTree(router.routeTree),
        });
      });
    };
    const timer = window.setTimeout(load, 2000);
    return () => {
      cancel = true;
      dispose();
      window.clearTimeout(timer);
    };
  }, [router]);

  return null;
}
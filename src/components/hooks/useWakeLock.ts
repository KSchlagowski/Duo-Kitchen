import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

// The opt-in "Keep screen on" of cook mode (S-11, D9), over the Screen Wake Lock API. `supported` is
// false on the server and while hydrating, then reflects `"wakeLock" in navigator`. `active` is the
// user's choice: the browser drops the lock whenever the tab is hidden, so it is re-requested when the
// tab is visible again, and released on toggle-off and unmount. A rejected request turns it off.

const noSubscribe = () => () => undefined;

export function useWakeLock() {
  const supported = useSyncExternalStore(
    noSubscribe,
    () => "wakeLock" in navigator,
    () => false,
  );
  const [active, setActiveState] = useState(false);
  const wanted = useRef(false);
  const sentinel = useRef<WakeLockSentinel | null>(null);

  const release = useCallback(() => {
    const lock = sentinel.current;
    sentinel.current = null;
    if (lock && !lock.released) lock.release().catch(() => undefined);
  }, []);

  const request = useCallback(async () => {
    try {
      const lock = await navigator.wakeLock.request("screen");
      if (!wanted.current) {
        // Toggled off while the request was in flight.
        await lock.release();
        return;
      }
      sentinel.current = lock;
    } catch {
      wanted.current = false;
      setActiveState(false);
    }
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (wanted.current && document.visibilityState === "visible" && (sentinel.current?.released ?? true)) {
        void request();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      wanted.current = false;
      release();
    };
  }, [release, request]);

  const setActive = (value: boolean) => {
    wanted.current = value;
    setActiveState(value);
    if (value) {
      void request();
    } else {
      release();
    }
  };

  return { supported, active, setActive };
}

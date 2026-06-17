import { useEffect, useState } from "react";
import { loadRuns } from "../models/runStore";

export function useStoredRuns() {
  const [runs, setRuns] = useState(() => loadRuns());

  useEffect(() => {
    const sync = () => setRuns(loadRuns());
    window.addEventListener("storage", sync);
    window.addEventListener("agent-guard-runs-updated", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("agent-guard-runs-updated", sync);
    };
  }, []);

  return runs;
}

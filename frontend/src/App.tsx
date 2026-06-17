import { Navigate, Route, Routes } from "react-router-dom";
import { Shell } from "./components/layout/Shell";
import { Artifacts } from "./pages/Artifacts/Artifacts";
import { CLineConsole } from "./pages/CLineConsole/CLineConsole";
import { Dashboard } from "./pages/Dashboard/Dashboard";
import { NewTestRun } from "./pages/NewTestRun/NewTestRun";
import { RunDetail } from "./pages/RunDetail/RunDetail";
import { TestRuns } from "./pages/TestRuns/TestRuns";

export function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Dashboard />} />
        <Route path="new-run" element={<NewTestRun />} />
        <Route path="runs" element={<TestRuns />} />
        <Route path="runs/:runGroupId" element={<RunDetail />} />
        <Route path="artifacts" element={<Artifacts />} />
        <Route path="cline" element={<CLineConsole />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

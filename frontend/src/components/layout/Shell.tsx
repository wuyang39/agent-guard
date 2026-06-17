import { NavLink, Outlet } from "react-router-dom";
import { Activity, FileText, Gauge, History, PlayCircle, ShieldCheck } from "lucide-react";

const navItems = [
  { to: "/", label: "Dashboard", icon: Gauge },
  { to: "/new-run", label: "New Test Run", icon: PlayCircle },
  { to: "/runs", label: "Test Runs", icon: History },
  { to: "/artifacts", label: "Artifacts", icon: FileText },
];

export function Shell() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <ShieldCheck size={28} />
          <div>
            <strong>Agent Guard</strong>
            <span>Security Console</span>
          </div>
        </div>
        <nav className="nav-list" aria-label="Primary">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
                <Icon size={18} />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>
        <div className="runtime-note">
          <Activity size={16} />
          <span>Demo runtime adapter</span>
        </div>
      </aside>
      <main className="main-panel">
        <Outlet />
      </main>
    </div>
  );
}

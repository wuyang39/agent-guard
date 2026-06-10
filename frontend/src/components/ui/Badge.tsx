import type React from "react";

type BadgeProps = {
  children: React.ReactNode;
  tone?: string;
};

export function Badge({ children, tone = "tone-neutral" }: BadgeProps) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

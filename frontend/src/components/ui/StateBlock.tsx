import type React from "react";

type StateBlockProps = {
  title: string;
  message: string;
  action?: React.ReactNode;
};

export function LoadingBlock({ message }: { message: string }) {
  return (
    <div className="state-block">
      <div className="spinner" aria-hidden="true" />
      <p>{message}</p>
    </div>
  );
}

export function EmptyBlock({ title, message, action }: StateBlockProps) {
  return (
    <div className="state-block">
      <h2>{title}</h2>
      <p>{message}</p>
      {action}
    </div>
  );
}

export function ErrorBlock({ title, message, action }: StateBlockProps) {
  return (
    <div className="state-block state-error">
      <h2>{title}</h2>
      <p>{message}</p>
      {action}
    </div>
  );
}

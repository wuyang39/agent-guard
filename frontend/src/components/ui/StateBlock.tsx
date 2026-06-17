import { AlertCircle, Loader2 } from "lucide-react";
import type React from "react";

type StateBlockProps = {
  title: string;
  detail?: string;
  kind?: "loading" | "empty" | "error";
  action?: React.ReactNode;
};

export function StateBlock({ title, detail, kind = "empty", action }: StateBlockProps) {
  return (
    <div className={`state-block state-${kind}`}>
      {kind === "loading" ? <Loader2 className="state-icon spin" size={22} /> : <AlertCircle className="state-icon" size={22} />}
      <div>
        <strong>{title}</strong>
        {detail ? <p>{detail}</p> : null}
      </div>
      {action}
    </div>
  );
}

type DetailedStateBlockProps = {
  title: string;
  message: string;
  action?: React.ReactNode;
};

export function LoadingBlock({ message }: { message: string }) {
  return (
    <div className="state-block state-loading">
      <Loader2 className="state-icon spin" size={22} aria-hidden="true" />
      <div>
        <strong>Loading</strong>
        <p>{message}</p>
      </div>
    </div>
  );
}

export function EmptyBlock({ title, message, action }: DetailedStateBlockProps) {
  return <StateBlock title={title} detail={message} action={action} />;
}

export function ErrorBlock({ title, message, action }: DetailedStateBlockProps) {
  return <StateBlock kind="error" title={title} detail={message} action={action} />;
}

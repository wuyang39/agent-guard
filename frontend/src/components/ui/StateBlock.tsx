import { AlertCircle, Loader2 } from "lucide-react";

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

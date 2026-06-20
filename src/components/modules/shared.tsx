import React from "react";
import { I } from "../../lib/context";

export function PageHead({ mod, kicker, title, sub, children, icon }: {
  mod: string; kicker: string; title: string; sub?: string; children?: React.ReactNode; icon: string;
}) {
  return (
    <div className="page-head">
      <div className="ph-meta">
        <div className="page-kicker" style={{ "--mod": mod } as any}><I n={icon} w="fill" /> {kicker}</div>
        <h1 className="page-title">{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}

export function PageHeadCompact({ mod, icon, title, count }: { mod: string; icon: string; title: string; count: number }) {
  return (
    <div>
      <div className="page-kicker" style={{ "--mod": mod, marginBottom: 4 } as any}><I n={icon} w="fill" /> Knowledge</div>
      <div className="row" style={{ gap: 9 }}>
        <h1 className="page-title" style={{ fontSize: "var(--fs-3xl)" }}>{title}</h1>
        <span className="mono-sm ghost">{count}</span>
      </div>
    </div>
  );
}

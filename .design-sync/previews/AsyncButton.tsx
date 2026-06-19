import React from "react";
import { AsyncButton } from "loom";

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const Wrap = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: "oklch(0.145 0.008 286)", padding: "16px 20px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
    {children}
  </div>
);

export function Default() {
  return (
    <Wrap>
      <AsyncButton
        className="btn"
        onClick={() => delay(1200)}
      >
        Sync Now
      </AsyncButton>
    </Wrap>
  );
}

export function WithIcon() {
  return (
    <Wrap>
      <AsyncButton
        className="btn"
        icon="ph-cloud-arrow-up"
        onClick={() => delay(1200)}
      >
        Upload
      </AsyncButton>
      <AsyncButton
        className="btn primary"
        icon="ph-paper-plane-tilt"
        onClick={() => delay(900)}
      >
        Publish
      </AsyncButton>
    </Wrap>
  );
}

export function WithLoadingLabel() {
  return (
    <Wrap>
      <AsyncButton
        className="btn primary"
        icon="ph-floppy-disk"
        loadingLabel="Saving…"
        onClick={() => delay(1500)}
      >
        Save Changes
      </AsyncButton>
    </Wrap>
  );
}

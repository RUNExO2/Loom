import React from "react";
import { Button } from "loom";

// Loom is dark-mode first — wrap stories in the app's base background color
// so token values (near-zero-opacity surfaces) are visible against dark bg.
const Dark = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: "oklch(0.145 0.008 286)", padding: "16px 20px", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
    {children}
  </div>
);

export function AllVariants() {
  return (
    <Dark>
      <Button>Secondary</Button>
      <Button variant="primary">Primary</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="destructive">Delete</Button>
    </Dark>
  );
}

export function Sizes() {
  return (
    <Dark>
      <Button size="sm">Small</Button>
      <Button size="md">Medium</Button>
      <Button size="lg">Large</Button>
    </Dark>
  );
}

export function WithIcons() {
  return (
    <Dark>
      <Button iconLeft="ph-plus">Add Item</Button>
      <Button variant="primary" iconLeft="ph-floppy-disk">Save</Button>
      <Button variant="ghost" iconRight="ph-arrow-right">Continue</Button>
    </Dark>
  );
}

export function IconOnly() {
  return (
    <Dark>
      <Button iconOnly="ph-magnifying-glass" aria-label="Search" />
      <Button iconOnly="ph-gear" aria-label="Settings" />
      <Button iconOnly="ph-plus" variant="primary" aria-label="Add" />
      <Button iconOnly="ph-trash" variant="destructive" aria-label="Delete" />
    </Dark>
  );
}

export function States() {
  return (
    <Dark>
      <Button variant="primary" loading>Saving…</Button>
      <Button disabled>Disabled</Button>
      <Button variant="primary" disabled>Disabled Primary</Button>
    </Dark>
  );
}

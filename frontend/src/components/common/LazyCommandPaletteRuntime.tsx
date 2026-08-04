import React, { Suspense } from "react";

const LazyCommandPalette = React.lazy(() => import("./CommandPalette"));

interface LazyCommandPaletteRuntimeProps {
  open: boolean;
  onClose: () => void;
}

/** SearchCenter and command-search helpers are not needed until the palette is actually opened. */
export default function LazyCommandPaletteRuntime(props: LazyCommandPaletteRuntimeProps) {
  if (!props.open) return null;
  return (
    <Suspense fallback={null}>
      <LazyCommandPalette {...props} />
    </Suspense>
  );
}

import { Profiler, type PropsWithChildren } from "react";
import { recordPhaseAPerfEvent } from "@/lib/phaseAPerfDiagnostics";

export function PhaseAPerfProfiler({ children, id = "TiptapEditor" }: PropsWithChildren<{ id?: string }>) {
  if (import.meta.env.VITE_PHASE_A_PERF !== "1") return children;
  return (
    <Profiler
      id={id}
      onRender={(profilerId, phase, actualDuration) => {
        recordPhaseAPerfEvent({
          type: "react-commit",
          durationMs: actualDuration,
          detail: { id: profilerId, phase },
        });
      }}
    >
      {children}
    </Profiler>
  );
}

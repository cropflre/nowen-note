import { Fragment, Profiler, type PropsWithChildren, type ReactNode } from "react";
import OnboardingOpenBridge from "@/components/OnboardingOpenBridge";
import { recordPhaseAPerfEvent } from "@/lib/phaseAPerfDiagnostics";

function withAppOnboarding(children: ReactNode, id: string): ReactNode {
  if (id !== "AppLayout") return children;
  return (
    <Fragment>
      <OnboardingOpenBridge />
      {children}
    </Fragment>
  );
}

export function PhaseAPerfProfiler({ children, id = "TiptapEditor" }: PropsWithChildren<{ id?: string }>) {
  const content = withAppOnboarding(children, id);
  if (import.meta.env.VITE_PHASE_A_PERF !== "1") return content;
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
      {content}
    </Profiler>
  );
}

import React from "react";
import Sidebar from "@/components/Sidebar";
import NoteList from "@/components/NoteList";
import EditorPane from "@/components/EditorPane";
import TaskCenter from "@/components/TaskCenter";
import { AppProvider, useApp } from "@/store/AppContext";
import { ThemeProvider } from "@/components/ThemeProvider";
import { TooltipProvider } from "@/components/ui/tooltip";

function AppLayout() {
  const { state } = useApp();
  const isTaskView = state.viewMode === "tasks";

  return (
    <div className="flex h-screen w-screen bg-app-bg overflow-hidden transition-colors duration-200">
      <Sidebar />
      {isTaskView ? (
        <TaskCenter />
      ) : (
        <>
          <NoteList />
          <EditorPane />
        </>
      )}
    </div>
  );
}

function App() {
  return (
    <ThemeProvider>
      <AppProvider>
        <TooltipProvider>
          <AppLayout />
        </TooltipProvider>
      </AppProvider>
    </ThemeProvider>
  );
}

export default App;

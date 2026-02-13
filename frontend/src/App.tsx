import React from "react";
import Sidebar from "@/components/Sidebar";
import NoteList from "@/components/NoteList";
import EditorPane from "@/components/EditorPane";
import { AppProvider } from "@/store/AppContext";
import { TooltipProvider } from "@/components/ui/tooltip";

function AppLayout() {
  return (
    <div className="flex h-screen w-screen bg-dark-bg overflow-hidden">
      <Sidebar />
      <NoteList />
      <EditorPane />
    </div>
  );
}

function App() {
  return (
    <AppProvider>
      <TooltipProvider>
        <AppLayout />
      </TooltipProvider>
    </AppProvider>
  );
}

export default App;

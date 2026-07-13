import { createAutosave, type Autosave, type AutosaveState } from "./autosave";

export interface ResearchDocument {
  id: string;
  title: string;
  content: string;
  revision: string;
}

export interface ResearchDocumentTransport {
  create(title: string, content: string): Promise<ResearchDocument>;
  read(id: string): Promise<ResearchDocument>;
  save(document: ResearchDocument): Promise<{ revision: string }>;
  promote(document: ResearchDocument): Promise<{ noteId: string }>;
}

export interface ResearchDocumentControllerOptions {
  document: ResearchDocument;
  getContent(): string;
  getTitle(): string;
  setDocument(document: ResearchDocument): void;
  transport: ResearchDocumentTransport;
  onState(state: AutosaveState): void;
  debounceMs?: number;
}

export interface ResearchDocumentController {
  autosave: Autosave;
  document(): ResearchDocument;
  reload(): Promise<void>;
  retry(): Promise<void>;
  overwrite(): Promise<void>;
  promote(): Promise<{ noteId: string }>;
  dispose(): void;
}

export async function createResearchDocument(
  transport: ResearchDocumentTransport,
  title = "Untitled document",
  content = "",
): Promise<ResearchDocument> {
  return transport.create(title, content);
}

export function createResearchDocumentController(
  options: ResearchDocumentControllerOptions,
): ResearchDocumentController {
  let current = { ...options.document };
  let autosave: Autosave;

  const snapshot = (): ResearchDocument => ({
    id: current.id,
    revision: current.revision,
    title: options.getTitle(),
    content: options.getContent(),
  });

  autosave = createAutosave({
    baseContent: JSON.stringify({ title: current.title, content: current.content }),
    getContent: () =>
      JSON.stringify({ title: options.getTitle(), content: options.getContent() }),
    debounceMs: options.debounceMs,
    onState: options.onState,
    save: async (serialized) => {
      const edited = JSON.parse(serialized) as { title: string; content: string };
      const candidate = { ...snapshot(), ...edited };
      try {
        const result = await options.transport.save(candidate);
        current = { ...candidate, revision: result.revision };
        return "saved";
      } catch (error) {
        if (isConflict(error)) return "conflict";
        throw error;
      }
    },
  });

  return {
    autosave,
    document: () => ({ ...current, title: options.getTitle(), content: options.getContent() }),
    async reload() {
      const fresh = await options.transport.read(current.id);
      current = { ...fresh };
      options.setDocument(fresh);
      autosave.reset(JSON.stringify({ title: fresh.title, content: fresh.content }));
    },
    retry: () => autosave.flush(),
    async overwrite() {
      const local = options.getContent();
      const fresh = await options.transport.read(current.id);
      current = { ...fresh, title: options.getTitle(), content: local };
      autosave.reset(JSON.stringify({ title: fresh.title, content: fresh.content }));
      await autosave.flush();
    },
    async promote() {
      await autosave.flush();
      if (autosave.state() !== "clean") throw new Error("document-not-saved");
      return options.transport.promote({ ...current });
    },
    dispose() {
      autosave.dispose();
    },
  };
}

function isConflict(error: unknown): boolean {
  return !!error && typeof error === "object" && "status" in error && error.status === 409;
}

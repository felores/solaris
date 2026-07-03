// Minimal interface i18n for Solaris. EN + ES dictionaries, a t() lookup, a
// persisted language (localStorage 'akasha-lang', defaulting to the browser
// language and falling back to EN), and hydrate() which translates the static
// chrome tagged with data-i18n / data-i18n-ph / data-i18n-title / data-i18n-html.
//
// ES is neutral Spanish (tu, not vos) with no em dashes (repo rule). Proper
// nouns and model slugs (Obsidian, Exa, qmd, provider/model ids) stay as-is.

export type Lang = "en" | "es";
type Dict = Record<string, string>;

const EN: Dict = {
  // menubar
  "menu.file": "File",
  "menu.layers": "Layers",
  "menu.view": "View",
  "menu.tools": "Tools",
  "menu.help": "Help",
  "lang.menu": "Language",
  // File
  "file.rescan": "Rescan Vault",
  "file.rescanFull": "Full Rescan",
  "file.reload": "Reload App",
  "file.export": "Export Image (PNG)",
  "file.copyLink": "Copy Link to Selected Note",
  "file.obsidian": "Open Selected in Obsidian",
  "file.clearHistory": "Clear History",
  "hint.incremental": "incremental",
  "hint.coldReread": "cold, re-reads all",
  "hint.researchNotes": "research + notes",
  // View
  "view.fullscreen": "Toggle Fullscreen",
  "view.resetCam": "Reset Camera",
  "ctl.theme": "theme",
  "ctl.graphics": "graphics",
  "ctl.nodes": "nodes",
  "ctl.depth": "focus depth",
  "ctl.group": "group by",
  "toggle.glow": "glow (G)",
  "toggle.labels": "labels (L)",
  "toggle.orphans": "orphans (O)",
  "toggle.unwritten": "unwritten (U)",
  // Help
  "help.shortcuts": "Keyboard & Mouse Controls",
  "help.about": "About Solaris",
  // Tools
  "tools.filters": "Display Filters…",
  "tools.settings": "Display Settings…",
  "integ.ingestion": "Ingestion",
  "integ.web": "Web Research",
  "integ.semantics": "Semantics",
  "integ.llm": "LLM Provider",
  "integ.install": "install",
  "integ.recheck": "re-check installed tools",
  "integ.enableSemantic": "enable semantic search",
  "integ.embedModel": "embedding model",
  "integ.model": "Model",
  "qmd.update": "update",
  "qmd.embed": "embed",
  "qmd.reembed": "re-embed",
  "integ.getKey": "Get a key",
  "integ.billing": "Billing",
  "integ.addCredits": "Add credits",
  "integ.browseModels": "Browse models",
  "integ.findEmbed": "Find embedding models",
  "ph.exaKey": "Exa API key — paste + Enter",
  "ph.orKey": "OpenRouter API key — paste + Enter",
  "ph.embedCustom": "hf:org/repo/file.gguf + Enter",
  "ph.llmModel": "provider/model + Enter",
  // search + modes
  "ph.ingestBrowse": "browse…",
  "search.ph.none": "Search notes…",
  "search.ph.semantic": "Semantic search…",
  "search.ph.web": "Web research…",
  "search.ph.ingest": "/path/to/file.pdf or https://…",
  "mode.semantic.name": "Semantic (qmd)",
  "mode.web.name": "Web (Exa)",
  "mode.ingest.name": "Ingest (markitdown)",
  "mode.semantic.missing":
    "Semantic (qmd) — qmd not installed. Add it via the addons install (Tools → Integrations).",
  "mode.web.missing":
    "Web (Exa) — no API key. Add your Exa key in Tools → Integrations.",
  "mode.ingest.missing":
    "Ingest (markitdown) — markitdown not installed. Add it via the addons install (Tools → Integrations).",
  // Settings panel
  "settings.display": "Display",
  "settings.labelDistance": "label distance",
  "settings.labelSize": "label size",
  "settings.nodeSize": "node size",
  "settings.linkOpacity": "link opacity",
  "settings.minWeight": "min link weight",
  "settings.particles": "particles / node",
  "settings.weighting": "Node size weighting",
  "settings.wIn": "incoming links",
  "settings.wOut": "outgoing links",
  "settings.wWords": "words in file",
  "settings.wContrast": "size contrast",
  "settings.resetColors": "reset custom colors",
  // reader / research chrome
  "reader.prev": "Previous note",
  "reader.next": "Next note",
  "reader.obsidian": "Open in Obsidian",
  "reader.close": "Close (Esc)",
  "reader.head": "Drag to move · double-click to re-dock",
  "reader.resize": "Drag to resize",
  "reader.unwritten": "unwritten — linked but not yet created",
  "research.title": "Research",
  "research.prev": "Older result",
  "research.next": "Newer result",
  "research.trash": "Delete this result from history",
  "research.close": "Close (Esc)",
  "research.send": "Send",
  "ph.researchInput": "follow up…",
  "research.semantic": "Semantic results",
  "research.web": "Web research",
  "research.ingest": "Ingest document",
  "research.ph.web": "another web query…",
  "research.ph.ingest": "another path or URL…",
  "research.ph.semantic": "another semantic query…",
  "dock.dock": "Dock to right edge",
  "dock.undock": "Undock (float)",
  // loading hint
  "loading.line1":
    "Left-drag to rotate · scroll to zoom · right-drag or Shift+arrows to pan",
  "loading.line2":
    "Click a node to read it · double-click to open in Obsidian · press <kbd>/</kbd> to search",
};

const ES: Dict = {
  "menu.file": "Archivo",
  "menu.layers": "Capas",
  "menu.view": "Vista",
  "menu.tools": "Herramientas",
  "menu.help": "Ayuda",
  "lang.menu": "Idioma",
  "file.rescan": "Reescanear bóveda",
  "file.rescanFull": "Reescaneo completo",
  "file.reload": "Recargar app",
  "file.export": "Exportar imagen (PNG)",
  "file.copyLink": "Copiar enlace a la nota seleccionada",
  "file.obsidian": "Abrir seleccionada en Obsidian",
  "file.clearHistory": "Borrar historial",
  "hint.incremental": "incremental",
  "hint.coldReread": "en frío, relee todo",
  "hint.researchNotes": "investigación + notas",
  "view.fullscreen": "Pantalla completa",
  "view.resetCam": "Restablecer cámara",
  "ctl.theme": "tema",
  "ctl.graphics": "gráficos",
  "ctl.nodes": "nodos",
  "ctl.depth": "profundidad de enfoque",
  "ctl.group": "agrupar por",
  "toggle.glow": "resplandor (G)",
  "toggle.labels": "etiquetas (L)",
  "toggle.orphans": "huérfanos (O)",
  "toggle.unwritten": "sin crear (U)",
  "help.shortcuts": "Controles de teclado y ratón",
  "help.about": "Acerca de Solaris",
  "tools.filters": "Filtros de visualización…",
  "tools.settings": "Ajustes de visualización…",
  "integ.ingestion": "Ingesta",
  "integ.web": "Investigación web",
  "integ.semantics": "Semántica",
  "integ.llm": "Proveedor LLM",
  "integ.install": "instalar",
  "integ.recheck": "volver a comprobar herramientas",
  "integ.enableSemantic": "activar búsqueda semántica",
  "integ.embedModel": "modelo de embeddings",
  "integ.model": "Modelo",
  "qmd.update": "actualizar",
  "qmd.embed": "vectorizar",
  "qmd.reembed": "revectorizar",
  "integ.getKey": "Obtener clave",
  "integ.billing": "Facturación",
  "integ.addCredits": "Añadir créditos",
  "integ.browseModels": "Ver modelos",
  "integ.findEmbed": "Buscar modelos de embeddings",
  "ph.exaKey": "Clave API de Exa: pegar + Enter",
  "ph.orKey": "Clave API de OpenRouter: pegar + Enter",
  "ph.embedCustom": "hf:org/repo/file.gguf + Enter",
  "ph.llmModel": "proveedor/modelo + Enter",
  "ph.ingestBrowse": "examinar…",
  "search.ph.none": "Buscar notas…",
  "search.ph.semantic": "Búsqueda semántica…",
  "search.ph.web": "Investigación web…",
  "search.ph.ingest": "/ruta/al/archivo.pdf o https://…",
  "mode.semantic.name": "Semántica (qmd)",
  "mode.web.name": "Web (Exa)",
  "mode.ingest.name": "Ingesta (markitdown)",
  "mode.semantic.missing":
    "Semántica (qmd): qmd no está instalado. Añádelo desde la instalación de addons (Herramientas → Integraciones).",
  "mode.web.missing":
    "Web (Exa): sin clave API. Añade tu clave de Exa en Herramientas → Integraciones.",
  "mode.ingest.missing":
    "Ingesta (markitdown): markitdown no está instalado. Añádelo desde la instalación de addons (Herramientas → Integraciones).",
  "settings.display": "Visualización",
  "settings.labelDistance": "distancia de etiquetas",
  "settings.labelSize": "tamaño de etiquetas",
  "settings.nodeSize": "tamaño de nodos",
  "settings.linkOpacity": "opacidad de enlaces",
  "settings.minWeight": "peso mínimo de enlace",
  "settings.particles": "partículas / nodo",
  "settings.weighting": "Ponderación del tamaño de nodos",
  "settings.wIn": "enlaces entrantes",
  "settings.wOut": "enlaces salientes",
  "settings.wWords": "palabras en el archivo",
  "settings.wContrast": "contraste de tamaño",
  "settings.resetColors": "restablecer colores personalizados",
  "reader.prev": "Nota anterior",
  "reader.next": "Nota siguiente",
  "reader.obsidian": "Abrir en Obsidian",
  "reader.close": "Cerrar (Esc)",
  "reader.head": "Arrastra para mover · doble clic para reacoplar",
  "reader.resize": "Arrastra para redimensionar",
  "reader.unwritten": "sin crear: enlazada pero aún no existe",
  "research.title": "Investigación",
  "research.prev": "Resultado anterior",
  "research.next": "Resultado siguiente",
  "research.trash": "Eliminar este resultado del historial",
  "research.close": "Cerrar (Esc)",
  "research.send": "Enviar",
  "ph.researchInput": "seguir preguntando…",
  "research.semantic": "Resultados semánticos",
  "research.web": "Investigación web",
  "research.ingest": "Ingerir documento",
  "research.ph.web": "otra consulta web…",
  "research.ph.ingest": "otra ruta o URL…",
  "research.ph.semantic": "otra consulta semántica…",
  "dock.dock": "Acoplar al borde derecho",
  "dock.undock": "Desacoplar (flotante)",
  "loading.line1":
    "Arrastra con clic izquierdo para rotar · rueda para zoom · clic derecho o Mayús+flechas para desplazar",
  "loading.line2":
    "Haz clic en un nodo para leerlo · doble clic para abrir en Obsidian · pulsa <kbd>/</kbd> para buscar",
};

const DICTS: Record<Lang, Dict> = { en: EN, es: ES };

function detect(): Lang {
  const saved = localStorage.getItem("akasha-lang");
  if (saved === "en" || saved === "es") return saved;
  return (navigator.language || "en").toLowerCase().startsWith("es")
    ? "es"
    : "en";
}

let lang: Lang = detect();

export function getLang(): Lang {
  return lang;
}

export function setLang(l: Lang): void {
  lang = l;
  localStorage.setItem("akasha-lang", l);
  document.documentElement.lang = l;
  hydrate();
}

export function t(key: string, vars?: Record<string, string | number>): string {
  let s = DICTS[lang][key] ?? EN[key] ?? key;
  if (vars)
    for (const [k, v] of Object.entries(vars))
      s = s.replace(`{${k}}`, String(v));
  return s;
}

// Translate the tagged static chrome. Idempotent: safe to call on every toggle.
// [data-i18n] on an element that also holds child elements (a button with a
// .mi-hint span, a label wrapping a control) rewrites only the leading text node
// so the children survive; on a leaf element it sets textContent.
export function hydrate(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const txt = t(el.dataset.i18n!);
    if (el.childElementCount > 0) {
      if (el.firstChild && el.firstChild.nodeType === Node.TEXT_NODE) {
        el.firstChild.textContent = txt + " ";
      } else {
        el.insertBefore(document.createTextNode(txt + " "), el.firstChild);
      }
    } else {
      el.textContent = txt;
    }
  });
  root
    .querySelectorAll<HTMLElement>("[data-i18n-html]")
    .forEach((el) => (el.innerHTML = t(el.dataset.i18nHtml!)));
  root
    .querySelectorAll<HTMLInputElement>("[data-i18n-ph]")
    .forEach((el) => (el.placeholder = t(el.dataset.i18nPh!)));
  root
    .querySelectorAll<HTMLElement>("[data-i18n-title]")
    .forEach((el) => (el.title = t(el.dataset.i18nTitle!)));
}

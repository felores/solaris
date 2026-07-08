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
  "lang.menu": "Language",
  // File
  "file.rescan": "Rescan Vault",
  "file.rescanFull": "Full Rescan",
  "file.reload": "Reload App",
  "file.export": "Export Image (PNG)",
  "file.copyLink": "Copy Link to Selected Note",
  "file.obsidian": "Open Selected in Obsidian",
  "file.clearHistory": "Clear History",
  "file.admin": "Admin…",
  "hint.incremental": "incremental",
  "hint.coldReread": "cold, re-reads all",
  "hint.researchNotes": "research + notes",
  // Admin modal
  "admin.title": "Admin",
  "admin.vault": "Vault",
  "admin.vaultPath": "Active vault path",
  "admin.vaultPathPlaceholder": "/path/to/vault",
  "admin.unsavedSave": "Save Admin changes before closing?",
  "admin.unsavedDiscard": "Discard unsaved Admin changes?",
  "admin.wikis": "Wikis",
  "admin.wikisHint": "Folders named wiki detected in the active vault",
  "admin.prompts": "Prompts",
  "admin.promptsHint": "Local overrides; reset restores the built-in default",
  "admin.wikiEnable": "enabled",
  "admin.wikiLabel": "label",
  "admin.wikiPath": "path",
  "admin.wikiConf": "confidence",
  "admin.wikiContracts": "contracts",
  "admin.wikiRaw": "raw folder",
  "admin.wikiRawHint": "wiki-relative; e.g. raw/, ../research/, ../raw/, or blank",
  "admin.addManual": "Add manual wiki path",
  "admin.manualPlaceholder": "vault-relative path, e.g. notes/my-wiki",
  "admin.rediscover": "Rediscover",
  "admin.save": "Save",
  "admin.saving": "saving…",
  "admin.saved": "saved ✓",
  "admin.saveFail": "save failed — retry",
  "admin.reset": "Reset",
  "admin.empty": "No wikis detected. Add a manual path or create a wiki/ folder in the vault.",
  "admin.loading": "discovering wikis…",
  // View
  "view.fullscreen": "Toggle Fullscreen",
  "view.resetCam": "Reset Camera",
  "ctl.theme": "theme",
  "ctl.graphics": "graphics",
  "ctl.nodes": "nodes",
  "ctl.depth": "focus depth",
  "ctl.group": "group by",
  "ctl.arrange": "arrangement",
  "toggle.glow": "glow (G)",
  "toggle.labels": "labels (L)",
  "toggle.orphans": "orphans (O)",
  "toggle.unwritten": "unwritten (U)",
  "toggle.semLines": "semantic lines",
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
  "integ.model": "Model",
  "qmd.update": "update",
  "qmd.embed": "embed",
  "qmd.reembed": "re-embed",
  "integ.getKey": "Get a key",
  "integ.billing": "Billing",
  "integ.addCredits": "Add credits",
  "integ.browseModels": "Browse models",
  "ph.exaKey": "Exa API key — paste + Enter",
  "ph.orKey": "OpenRouter API key — paste + Enter",
  "ph.llmModel": "provider/model + Enter",
  // voice assistant
  "integ.voice": "Voice Assistant",
  "voice.provider": "Provider",
  "voice.voice": "Voice",
  "voice.toggle": "Voice assistant",
  "voice.ready": "ready",
  "voice.needsKey": "needs key",
  "voice.configure": "Set a voice provider + key in Tools → Voice Assistant",
  "voice.connecting": "connecting…",
  "voice.stop": "Stop voice session",
  "ph.voiceKey": "{provider} API key — paste + Enter",
  "ph.voiceKeySaved": "{provider} key saved ✓ — paste to replace",
  "ph.voiceKeyFail": "save failed — retry",
  // voice tool status
  "voice.status.currentView": "Checking current view…",
  "voice.status.searchingVault": "Searching vault for: {query}",
  "voice.status.searchingPassages": "Searching passages for: {query}",
  "voice.status.readingPassage": "Reading passage from: {note}",
  "voice.status.searchingNote": "Searching in {note}: {query}",
  "voice.status.browsingFolder": "Browsing folder: {path}",
  "voice.status.findingNotes": "Finding notes: {query}",
  "voice.status.openingNote": "Opening note: {note}",
  "voice.status.openingLastNote": "Opening last note…",
  "voice.status.openingLastResearch": "Opening last research…",
  "voice.status.listingWikis": "Listing wikis…",
  "voice.status.readingWiki": "Reading wiki contract: {wiki}",
  "voice.status.writingDocument": "Writing document: {title}",
  "voice.status.savingDocument": "Saving document to vault…",
  "voice.status.editingNote": "Editing note: {note}",
  "voice.status.searchingWeb": "Searching web for: {query}",
  "voice.status.fetchingUrl": "Fetching URL: {url}",
  // search + modes
  "ph.ingestBrowse": "browse…",
  "search.ph.none": "Search notes…",
  "search.ph.vault": "Search vault…",
  "search.ph.web": "Web research…",
  "search.ph.ingest": "/path/to/file.pdf or https://…",
  "mode.vault.name": "Vault",
  "mode.web.name": "Web",
  "mode.ingest.name": "Ingest",
  "ingest.targetChoose": "choose target…",
  "ingest.capture": "Inbox / capture only",
  "ingest.action": "ingest",
  "mode.vault.missing":
    "Vault search — qmd not installed. Add it via the addons install (Tools → Integrations).",
  "mode.web.missing":
    "Web — no API key. Add your Exa key in Tools → Integrations.",
  "mode.ingest.missing":
    "Ingest — markitdown not installed. Add it via the addons install (Tools → Integrations).",
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
  "reader.head": "Drag to move",
  "reader.resize": "Drag to resize",
  "reader.unwritten": "unwritten — linked but not yet created",
  "reader.copyPath": "Click to copy path",
  "reader.copied": "Copied!",
  "reader.versions": "Versions",
  "reader.restore": "Restore this version",
  "reader.restoreConfirm": "Replace the current note content with this old version? Only this file changes; the Git repository stays as-is.",
  "reader.restoreFailed": "Restore failed.",
  "reader.find.open": "Find in note",
  "reader.find.text": "Find in note…",
  "reader.find.prev": "Previous match",
  "reader.find.next": "Next match",
  "reader.find.inputTitle":
    "Find in this note (Enter next · Shift+Enter previous · Esc close)",
  "research.title": "Research",
  "research.prev": "Older result",
  "research.next": "Newer result",
  "research.trash": "Delete this result from history",
  "research.close": "Close (Esc)",
  "research.semantic": "Semantic results",
  "research.keyword": "Keyword results",
  "research.web": "Web research",
  "research.ingest": "Ingest document",
  "research.article": "Article",
  "research.document": "Document",
  "research.sources": "Sources",
  "research.results": "Results",
  "research.saveNote": "save as note",
  "research.saveResearch": "save research as note",
  "research.saving": "saving…",
  "research.saved": "saved ✓",
  "research.saveFail": "save failed — retry",
  "research.expand": "expand",
  "research.collapse": "collapse",
  "research.openArticle": "Open the full article",
  "research.fetching": "fetching the full article…",
  "research.deepBusy":
    "researching deeply — synthesizing an answer from multiple sources, this can take up to a minute…",
  "research.webBusy": "searching the web…",
  "q.vault": "vault",
  "q.vaultTitle": "Answer from your vault (semantic search)",
  "q.web": "web",
  "q.webTitle": "Answer from the web (deep research)",
  "q.generating": "generating…",
  "q.button": "research questions",
  "q.buttonTitle": "Generate research questions from this note",
  "scope.deep": "Deep research",
  "scope.web": "Web results",
  "scope.semantic": "Semantic search",
  "scope.keyword": "Keyword search",
  "selection.include": "Include selected text as context",
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
  "lang.menu": "Idioma",
  "file.rescan": "Reescanear bóveda",
  "file.rescanFull": "Reescaneo completo",
  "file.reload": "Recargar app",
  "file.export": "Exportar imagen (PNG)",
  "file.copyLink": "Copiar enlace a la nota seleccionada",
  "file.obsidian": "Abrir seleccionada en Obsidian",
  "file.clearHistory": "Borrar historial",
  "file.admin": "Admin…",
  "hint.incremental": "incremental",
  "hint.coldReread": "en frío, relee todo",
  "hint.researchNotes": "investigación + notas",
  "admin.title": "Admin",
  "admin.vault": "Bóveda",
  "admin.vaultPath": "Ruta de bóveda activa",
  "admin.vaultPathPlaceholder": "/ruta/a/bóveda",
  "admin.unsavedSave": "¿Guardar cambios de Admin antes de cerrar?",
  "admin.unsavedDiscard": "¿Descartar cambios de Admin sin guardar?",
  "admin.wikis": "Wikis",
  "admin.wikisHint": "Carpetas llamadas wiki detectadas en la bóveda activa",
  "admin.prompts": "Prompts",
  "admin.promptsHint": "Overrides locales; reset restaura el valor por defecto",
  "admin.wikiEnable": "activada",
  "admin.wikiLabel": "etiqueta",
  "admin.wikiPath": "ruta",
  "admin.wikiConf": "confianza",
  "admin.wikiContracts": "contratos",
  "admin.wikiRaw": "carpeta raw",
  "admin.wikiRawHint": "relativa a la wiki; p. ej. raw/, ../research/, ../raw/ o vacío",
  "admin.addManual": "Añadir ruta manual",
  "admin.manualPlaceholder": "ruta relativa a la bóveda, p. ej. notes/my-wiki",
  "admin.rediscover": "Redescubrir",
  "admin.save": "Guardar",
  "admin.saving": "guardando…",
  "admin.saved": "guardado ✓",
  "admin.saveFail": "error al guardar — reintentar",
  "admin.reset": "Restablecer",
  "admin.empty": "No se detectaron wikis. Añade una ruta manual o crea una carpeta wiki/ en la bóveda.",
  "admin.loading": "descubriendo wikis…",
  "view.fullscreen": "Pantalla completa",
  "view.resetCam": "Restablecer cámara",
  "ctl.theme": "tema",
  "ctl.graphics": "gráficos",
  "ctl.nodes": "nodos",
  "ctl.depth": "profundidad de enfoque",
  "ctl.group": "agrupar por",
  "ctl.arrange": "disposición",
  "toggle.glow": "resplandor (G)",
  "toggle.labels": "etiquetas (L)",
  "toggle.orphans": "huérfanos (O)",
  "toggle.unwritten": "sin crear (U)",
  "toggle.semLines": "líneas semánticas",
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
  "integ.model": "Modelo",
  "qmd.update": "actualizar",
  "qmd.embed": "vectorizar",
  "qmd.reembed": "revectorizar",
  "integ.getKey": "Obtener clave",
  "integ.billing": "Facturación",
  "integ.addCredits": "Añadir créditos",
  "integ.browseModels": "Ver modelos",
  "ph.exaKey": "Clave API de Exa: pegar + Enter",
  "ph.orKey": "Clave API de OpenRouter: pegar + Enter",
  "ph.llmModel": "proveedor/modelo + Enter",
  // asistente de voz
  "integ.voice": "Asistente de voz",
  "voice.provider": "Proveedor",
  "voice.voice": "Voz",
  "voice.toggle": "Asistente de voz",
  "voice.ready": "lista",
  "voice.needsKey": "falta clave",
  "voice.configure":
    "Configura proveedor + clave en Herramientas → Asistente de voz",
  "voice.connecting": "conectando…",
  "voice.stop": "Detener sesión de voz",
  "ph.voiceKey": "Clave API de {provider}: pegar + Enter",
  "ph.voiceKeySaved": "Clave de {provider} guardada ✓: pega para reemplazar",
  "ph.voiceKeyFail": "error al guardar: reintenta",
  // voice tool status
  "voice.status.currentView": "Revisando vista actual…",
  "voice.status.searchingVault": "Buscando en la bóveda: {query}",
  "voice.status.searchingPassages": "Buscando pasajes: {query}",
  "voice.status.readingPassage": "Leyendo pasaje de: {note}",
  "voice.status.searchingNote": "Buscando en {note}: {query}",
  "voice.status.browsingFolder": "Explorando carpeta: {path}",
  "voice.status.findingNotes": "Buscando notas: {query}",
  "voice.status.openingNote": "Abriendo nota: {note}",
  "voice.status.openingLastNote": "Abriendo última nota…",
  "voice.status.openingLastResearch": "Abriendo última investigación…",
  "voice.status.listingWikis": "Listando wikis…",
  "voice.status.readingWiki": "Leyendo contrato wiki: {wiki}",
  "voice.status.writingDocument": "Escribiendo documento: {title}",
  "voice.status.savingDocument": "Guardando documento en el vault…",
  "voice.status.editingNote": "Editando nota: {note}",
  "voice.status.searchingWeb": "Buscando en la web: {query}",
  "voice.status.fetchingUrl": "Obteniendo URL: {url}",
  "ph.ingestBrowse": "examinar…",
  "search.ph.none": "Buscar notas…",
  "search.ph.vault": "Buscar en la bóveda…",
  "search.ph.web": "Investigación web…",
  "search.ph.ingest": "/ruta/al/archivo.pdf o https://…",
  "mode.vault.name": "Bóveda",
  "mode.web.name": "Web",
  "mode.ingest.name": "Ingesta",
  "ingest.targetChoose": "elige destino…",
  "ingest.capture": "Inbox / solo captura",
  "ingest.action": "ingesta",
  "mode.vault.missing":
    "Búsqueda en bóveda: qmd no está instalado. Añádelo desde la instalación de addons (Herramientas → Integraciones).",
  "mode.web.missing":
    "Web: sin clave API. Añade tu clave de Exa en Herramientas → Integraciones.",
  "mode.ingest.missing":
    "Ingesta: markitdown no está instalado. Añádelo desde la instalación de addons (Herramientas → Integraciones).",
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
  "reader.head": "Arrastra para mover",
  "reader.resize": "Arrastra para redimensionar",
  "reader.unwritten": "sin crear: enlazada pero aún no existe",
  "reader.copyPath": "Haz clic para copiar la ruta",
  "reader.copied": "¡Copiado!",
  "reader.versions": "Versiones",
  "reader.restore": "Restaurar esta versión",
  "reader.restoreConfirm": "¿Reemplazar el contenido actual de la nota por esta versión antigua? Solo cambia este archivo; el repositorio Git no se modifica.",
  "reader.restoreFailed": "Error al restaurar.",
  "reader.find.open": "Buscar en la nota",
  "reader.find.text": "Buscar en la nota…",
  "reader.find.prev": "Coincidencia anterior",
  "reader.find.next": "Coincidencia siguiente",
  "reader.find.inputTitle":
    "Buscar en esta nota (Enter siguiente · Shift+Enter anterior · Esc cerrar)",
  "research.title": "Investigación",
  "research.prev": "Resultado anterior",
  "research.next": "Resultado siguiente",
  "research.trash": "Eliminar este resultado del historial",
  "research.close": "Cerrar (Esc)",
  "research.semantic": "Resultados semánticos",
  "research.keyword": "Resultados por palabra clave",
  "research.web": "Investigación web",
  "research.ingest": "Ingerir documento",
  "research.article": "Artículo",
  "research.document": "Documento",
  "research.sources": "Fuentes",
  "research.results": "Resultados",
  "research.saveNote": "guardar como nota",
  "research.saveResearch": "guardar investigación como nota",
  "research.saving": "guardando…",
  "research.saved": "guardado ✓",
  "research.saveFail": "error al guardar — reintentar",
  "research.expand": "expandir",
  "research.collapse": "colapsar",
  "research.openArticle": "Abrir el artículo completo",
  "research.fetching": "trayendo el artículo completo…",
  "research.deepBusy":
    "investigando a fondo — sintetizando una respuesta de varias fuentes, puede tardar hasta un minuto…",
  "research.webBusy": "buscando en la web…",
  "q.vault": "bóveda",
  "q.vaultTitle": "Responder desde tu bóveda (búsqueda semántica)",
  "q.web": "web",
  "q.webTitle": "Responder desde la web (investigación profunda)",
  "q.generating": "generando…",
  "q.button": "preguntas de investigación",
  "q.buttonTitle": "Generar preguntas de investigación desde esta nota",
  "scope.deep": "Investigación profunda",
  "scope.web": "Resultados web",
  "scope.semantic": "Búsqueda semántica",
  "scope.keyword": "Búsqueda por palabra clave",
  "selection.include": "Incluir texto seleccionado como contexto",
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

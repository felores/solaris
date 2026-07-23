---
titulo: Fuentes nucleo para el paquete semilla de IA
tipo: investigacion
source: exa
lang: es
project: sinapso
created: 2026-07-22
estado: propuesta
---

# Fuentes nucleo para el paquete semilla de IA

## Pregunta

Que papers, especificaciones y reportes tecnicos deben fundamentar el primer paquete semilla de Sinapso para explicar grafos de conocimiento, software agéntico y skills o flujos modulares.

El criterio no es solo citacion academica. El paquete debe seleccionar fuentes que cumplan al menos dos de estas condiciones:

1. Fundamentan una idea que Sinapso ya usa o necesita.
2. Tienen adopcion verificable en implementaciones, estandares o ecosistemas de codigo abierto.
3. Son lo bastante legibles para convertirse en notas introductorias.
4. Se conectan con otras fuentes del paquete para formar un grafo, no una bibliografia aislada.

## Resultado

La seleccion recomendada contiene cuatro papers academicos y tres artefactos tecnicos de adopcion alta. Los ultimos no son papers revisados por pares, pero excluirlos haria que el paquete explique la teoria sin explicar los contratos que hoy permiten interoperar agentes y skills.

| Fuente | Tipo | Pilar principal | Por que entra |
| --- | --- | --- | --- |
| Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks | Paper, NeurIPS 2020 | Grafos y retrieval | Base de recuperacion de conocimiento externo antes de responder |
| From Local to Global: A Graph RAG Approach to Query-Focused Summarization | Reporte tecnico y proyecto Microsoft, 2024 | Grafos y retrieval | Distingue preguntas locales de preguntas globales sobre un corpus |
| ReAct: Synergizing Reasoning and Acting in Language Models | Paper, ICLR 2023 | Software agéntico | Modelo mental de razonamiento intercalado con acciones y herramientas |
| Toolformer: Language Models Can Teach Themselves to Use Tools | Paper, NeurIPS 2023 | Software agéntico | Fundamenta la utilidad de las herramientas para extender modelos |
| Model Context Protocol | Especificacion abierta | Software agéntico | Contrato de interoperabilidad entre agentes, datos y aplicaciones |
| DSPy: Compiling Declarative Language Model Calls into Self-Improving Pipelines | Paper y framework, 2024 | Skills y flujos | Separa programacion declarativa de prompts y permite evaluar pipelines |
| Agent Skills Specification | Especificacion abierta | Skills y flujos | Formato portable para capacidades modulares, progresivas y reutilizables |

## Fuentes y evidencia

### 1. Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks

- **Autores y ano:** Patrick Lewis et al., 2020.
- **Fuente primaria:** [arXiv](https://arxiv.org/abs/2005.11401)
- **Aporte:** combina recuperacion desde una memoria documental con generacion. Es la base conceptual para distinguir un modelo que responde desde parametros de uno que busca evidencia antes de responder.
- **Uso en Sinapso:** explica por que el baul local y QMD importan. El agente debe recuperar notas y fuentes relevantes, no intentar reconstruirlas desde memoria de conversacion.
- **Nodo semilla propuesto:** `retrieval-aumentado-y-conocimiento-local`.
- **Relaciones:** `qmd-y-busqueda`, `contexto-progresivo`, `fuentes-y-procedencia`.

### 2. From Local to Global: A Graph RAG Approach to Query-Focused Summarization

- **Autores y ano:** Darren Edge et al., 2024.
- **Fuente primaria:** [arXiv](https://arxiv.org/abs/2404.16130) y [Microsoft GraphRAG](https://github.com/microsoft/graphrag).
- **Aporte:** propone recuperar y resumir a escala de grafo. Diferencia consultas locales sobre entidades o hechos de consultas globales sobre temas, patrones o comunidades.
- **Evidencia de adopcion:** el repositorio `microsoft/graphrag` registraba 34.760 estrellas y 3.662 forks al revisar el 2026-07-22. Las estrellas no prueban calidad, pero si muestran una adopcion de desarrollo material alrededor de la propuesta.
- **Uso en Sinapso:** inspira el modo de exploracion del grafo y el dream cycle manual. Sinapso no tiene que implementar GraphRAG para aprovechar su distincion entre preguntas locales y globales.
- **Nodo semilla propuesto:** `graphrag-local-y-global`.
- **Relaciones:** `grafo-de-conocimiento`, `sinapso`, `dream-cycle-manual`, `qmd-y-busqueda`.

### 3. ReAct: Synergizing Reasoning and Acting in Language Models

- **Autores y ano:** Shunyu Yao et al., 2023.
- **Fuente primaria:** [arXiv](https://arxiv.org/abs/2210.03629) y [ICLR](https://openreview.net/forum?id=WE_vluYUL-X).
- **Aporte:** alterna razonamiento y acciones observables. El agente no solo produce una respuesta: decide buscar, leer, consultar una herramienta o validar una hipotesis antes de continuar.
- **Uso en Sinapso:** fundamenta la separacion entre companion, herramientas y resultados visibles. El usuario debe poder ver que fuente o herramienta se uso para una propuesta.
- **Nodo semilla propuesto:** `razonar-y-actuar-con-herramientas`.
- **Relaciones:** `mcp-e-integraciones`, `contratos-de-herramientas`, `permisos-y-aprobacion`, `observabilidad`.

### 4. Toolformer: Language Models Can Teach Themselves to Use Tools

- **Autores y ano:** Timo Schick et al., 2023.
- **Fuente primaria:** [arXiv](https://arxiv.org/abs/2302.04761) y [NeurIPS](https://proceedings.neurips.cc/paper_files/paper/2023/hash/da2e7918e1aeadcf7c235f794d50e5ce-Abstract-Conference.html).
- **Aporte:** demuestra que el uso de herramientas puede mejorar tareas que el modelo no deberia resolver solo, como calculo, busqueda o consulta de datos.
- **Uso en Sinapso:** justifica que las operaciones sobre el baul, la busqueda y las integraciones sean herramientas con entradas y salidas definidas, en lugar de instrucciones ambiguas en un prompt.
- **Nodo semilla propuesto:** `modelos-extendidos-por-herramientas`.
- **Relaciones:** `razonar-y-actuar-con-herramientas`, `mcp-e-integraciones`, `contratos-de-herramientas`.

### 5. Model Context Protocol

- **Tipo:** especificacion abierta, no paper academico.
- **Fuente primaria:** [Specification](https://modelcontextprotocol.io/specification) y [repositorio oficial](https://github.com/modelcontextprotocol/modelcontextprotocol).
- **Aporte:** define una interfaz para que clientes de IA descubran y usen herramientas, recursos y prompts de servidores externos.
- **Evidencia de adopcion:** el repositorio oficial registraba 8.663 estrellas y 1.661 forks al revisar el 2026-07-22. Su valor principal no es la citacion sino convertirse en el contrato de interoperabilidad que Sinapso ya expone.
- **Uso en Sinapso:** permite que OpenCode, Pi, Claude Code u otros hosts operen sobre el mismo baul sin que Sinapso dependa de un proveedor de modelos.
- **Nodo semilla propuesto:** `mcp-e-interoperabilidad-agentica`.
- **Relaciones:** `sinapso`, `contratos-de-herramientas`, `permisos-y-aprobacion`, `skills-portables`.

### 6. DSPy: Compiling Declarative Language Model Calls into Self-Improving Pipelines

- **Autores y ano:** Omar Khattab et al., 2024.
- **Fuente primaria:** [arXiv](https://arxiv.org/abs/2310.03714) y [repositorio DSPy](https://github.com/stanfordnlp/dspy).
- **Aporte:** trata componentes de IA como modulos declarativos y evaluables, no como prompts manuales monoliticos. Su leccion durable es separar la intencion del flujo de la eleccion concreta de modelo o prompt.
- **Evidencia de adopcion:** el repositorio `stanfordnlp/dspy` registraba 36.313 estrellas y 3.120 forks al revisar el 2026-07-22.
- **Uso en Sinapso:** informa la arquitectura de operaciones como el dream cycle manual: entradas declaradas, propuesta, aprobacion, resultado y verificacion. No implica que Sinapso deba incorporar DSPy como dependencia.
- **Nodo semilla propuesto:** `flujos-declarativos-y-evaluables`.
- **Relaciones:** `skills-portables`, `composicion-de-flujos`, `preview-y-verificacion`, `observabilidad`.

### 7. Agent Skills Specification

- **Tipo:** especificacion abierta, no paper academico.
- **Fuente primaria:** [Specification](https://agentskills.io/specification) y [repositorio oficial](https://github.com/agentskills/agentskills).
- **Aporte:** formaliza una capacidad de agente como directorio portable con `SKILL.md`, instrucciones y recursos progresivamente cargables.
- **Evidencia de adopcion:** el repositorio registraba 23.359 estrellas y 1.561 forks al revisar el 2026-07-22.
- **Uso en Sinapso:** es el mejor contrato inicial para que el bootstrap funcione tanto en Sinapso como en OpenCode, Pi, Claude Code u otros hosts. Permite evitar que cada proveedor requiera reescribir el conocimiento procedural.
- **Nodo semilla propuesto:** `skills-portables-y-progresivos`.
- **Relaciones:** `mcp-e-interoperabilidad-agentica`, `flujos-declarativos-y-evaluables`, `composicion-de-flujos`, `agentes-multihost`.

## Ancla interna: Sinapso

El paquete debe incluir una nota sobre Sinapso, pero no presentarla como fuente externa o paper. Es el nodo que vuelve concretas las siete fuentes anteriores.

- **Fuentes canónicas internas:** [`AGENTS.md`](../../AGENTS.md) y [`STRATEGY.md`](../../STRATEGY.md).
- **Rol dentro del paquete:** mostrar un ejemplo local de Markdown y YAML como fuente de verdad, grafo navegable, QMD opcional, MCP, propuestas de ingesta con aprobacion y operaciones LLM optativas.
- **Nodo semilla propuesto:** `sinapso-companion-de-conocimiento-local`.
- **Relaciones:** conecta con todas las rutas, especialmente `graphrag-local-y-global`, `mcp-e-interoperabilidad-agentica`, `skills-portables-y-progresivos` y `dream-cycle-manual`.

## Fuentes descartadas por ahora

### LEGO-GraphRAG

Es interesante para el diseño futuro de sistemas GraphRAG modulares, pero la investigacion encontrada no aporto evidencia suficiente de adopcion. No debe ocupar un nodo inicial frente a RAG y Microsoft GraphRAG.

### Advancing Intelligent Personal Assistants for Human Spaceflight

Su enfoque offline, de fiabilidad y seguridad es valioso, pero es demasiado especifico para el primer paquete. Puede servir despues para una ruta de companion seguro o sistemas de alto riesgo.

## Propuesta de uso editorial

Estas siete fuentes y la ancla interna Sinapso no deben convertirse en ocho resúmenes independientes. Deben sostener los 18 nodos previstos:

1. Tres mapas de ruta: grafos de conocimiento, software agéntico, skills y flujos.
2. Ocho nodos fuente: los siete trabajos externos y la nota de Sinapso.
3. Siete nodos puente: fuente de verdad, procedencia, retrieval, MCP, contratos de herramientas, permisos y aprobacion, dream cycle manual.

Antes de distribuir el paquete se debe revisar cada nota por claridad, atribucion, licencia, fecha de revision y conexiones bidireccionales.

## Limitaciones de la investigacion

- Las estrellas y forks de GitHub son indicadores de interes de desarrollo, no evidencia de calidad cientifica ni usuarios activos.
- La medicion de citaciones academicas se dejo fuera del ranking cuantitativo porque el endpoint consultado de Semantic Scholar respondio con limitacion de tasa durante esta investigacion.
- RAG, ReAct y Toolformer se seleccionan por influencia conceptual y publicacion academica. Antes de publicar el paquete conviene recuperar sus conteos de citaciones desde OpenAlex o Semantic Scholar en una consulta no limitada.
- Los estandares MCP y Agent Skills se incluyen por adopcion de ecosistema aunque no sean papers revisados por pares.

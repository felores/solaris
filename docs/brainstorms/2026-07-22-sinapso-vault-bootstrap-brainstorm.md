---
titulo: Brainstorm, bootstrap de baul y wiki para Sinapso
tipo: brainstorm
source: original
lang: es
project: sinapso
created: 2026-07-22
estado: borrador
---

# Brainstorm, bootstrap de baul y wiki para Sinapso

## Proposito

Diseñar la experiencia que permite a una persona crear su primer baul de conocimiento o mejorar uno existente desde Sinapso. El resultado debe ser un workspace local, legible por humanos y agentes, con contexto personal explicito, una wiki funcional, una primera visualizacion de relaciones y un camino claro para enriquecerlo.

Sinapso no entrega solo un skill para generar carpetas. Entrega una experiencia guiada que crea un primer valor visible antes de pedir proveedor, creditos o configuracion avanzada.

## Decisiones validadas

1. El producto inicial se llama **Crear mi baul** y tambien ofrece **Mejorar mi baul existente**.
2. Sinapso es el anfitrion nativo del onboarding. Agentes como OpenCode, Pi, Claude Code o Codex son superficies opcionales que pueden ejecutar el mismo flujo mediante integracion propia o MCP.
3. El baul es portable y local-first. Markdown, YAML, wikilinks y contratos son la fuente de verdad. Sinapso, proveedores y agentes no son dueños de los datos.
4. Los archivos de contexto principales viven en la raiz del baul, no en una carpeta `context/`.
5. El companion tiene una identidad general estable. Sus modos cambian segun tarea sin reescribir su identidad: explorador, investigador o constructor.
6. El primer valor debe funcionar sin LLM. Un LLM mejora y personaliza la experiencia, pero no la desbloquea.
7. El paquete semilla inicial es una sola wiki de IA con tres rutas conectadas, no tres wikis separadas.
8. Las notas semilla se importan por defecto como notas editables, marcadas con `tipo: semilla` y con fuentes explicitas.
9. Para un baul existente, Sinapso primero diagnostica y muestra un mapa de migracion. Nunca escribe cambios estructurales sin aprobacion explicita.
10. La v1 incluye un dream cycle manual mediante un boton. No incluye cronjobs, heartbeat recurrente, hosting de agentes ni automatizacion silenciosa.
11. Toda salida hacia OpenRouter, Exa u otro proveedor se explica antes de la primera accion y requiere consentimiento visible. Debe existir una opcion local o gratuita cuando sea viable.

## Estructura raiz propuesta

```text
AGENTS.md        <- contrato principal y mapa de operaciones
USER.md          <- perfil, proyectos activos y preferencias explicitas
SOUL.md          <- identidad del companion de Sinapso
GUARDRAILS.md    <- privacidad, permisos y acciones que requieren aprobacion
PROJECTS.md      <- opcional cuando los proyectos ya no caben en USER.md
wiki/            <- conocimiento sintetizado, si el usuario lo habilita
raw/             <- fuentes inmutables, si aplica al contrato elegido
```

La configuracion privada de Sinapso, secretos y proveedores se mantienen fuera del baul, en el directorio local de la aplicacion. Ninguna clave entra al repositorio ni a notas del usuario.

## Contrato de contexto

Un texto que diga "lee estos archivos" no impone carga determinista de contexto. El contrato debe declarar la carga minima por operacion y Sinapso debe ensamblarla al crear una solicitud de agente.

```text
Operacion de workspace
  -> AGENTS.md del baul o proyecto
  -> contrato de la wiki activa, si aplica
  -> proyecto activo indicado por USER.md o PROJECTS.md
  -> contexto puntual de la operacion
```

`USER.md` completo solo se entrega cuando el perfil personal sea relevante. La operacion no debe inyectar historiales, logs ni memoria de sesiones por defecto.

Los hosts externos no pueden garantizar por si solos que un modelo lea archivos. Para ellos, el skill y las herramientas MCP deben activar una operacion de preparacion de contexto. Sinapso si puede garantizar el ensamblaje al ser la superficie que construye el prompt y controla las operaciones.

## Companion y modos

`SOUL.md` describe un companion general de conocimiento. No se crean tres personajes ni se actualiza su identidad de manera automatica.

| Modo | Cuando se activa | Resultado esperado |
| --- | --- | --- |
| Explorador | Primer contacto, navegacion, deteccion de relaciones | Rutas, conexiones y proxima accion clara |
| Investigador | Fuentes, preguntas, evidencia o contradicciones | Sintesis trazable, incertidumbre y fuentes |
| Constructor | Skills, flujos, herramientas o decisiones operativas | Artefactos modulares, contratos y propuestas aplicables |

El modo activo debe mostrarse en la interfaz. No modifica `SOUL.md`, `USER.md` ni `GUARDRAILS.md`.

## Onboarding de un baul nuevo

La experiencia debe alternar preguntas cortas, cambios visibles y decisiones del usuario. No debe parecer un formulario largo.

1. Elegir entre crear un baul o mejorar uno existente.
2. Preguntar solo lo minimo: proposito, tipo de conocimiento y primer interes.
3. Mostrar una propuesta visual antes de escribir. Puede ser un mapa ASCII y, despues de crear archivos, el grafo real de Sinapso.
4. Solicitar aprobacion de la estructura propuesta.
5. Crear el contrato raiz, el perfil inicial y la wiki semilla.
6. Mostrar el primer mapa navegable y una ruta de aprendizaje concreta.
7. Invitar a una primera accion real: importar una fuente, conectar una nota o revisar el baul.
8. Solo despues ofrecer personalizacion con LLM, investigacion web o conexion de proveedores.

El onboarding debe permitir detenerse y continuar. El estado parcial debe ser visible y no depender de que el usuario complete todas las preguntas de una vez.

## Mejorar un baul existente

1. Escanear Markdown, YAML, enlaces, frontmatter, carpetas y wikis detectadas.
2. Mostrar el grafo y un diagnostico de estructura: posibles fuentes raw, contratos existentes, notas huerfanas, clusters y enlaces rotos.
3. Presentar un mapa de migracion en propuestas seleccionables: crear o reforzar `AGENTS.md`, iniciar wiki, declarar fuentes, normalizar rutas o enlazar notas.
4. Aplicar solamente las propuestas que el usuario apruebe.
5. Registrar los cambios aprobados para que el usuario pueda entender que se modifico y por que.

## Wiki semilla de IA

Una sola wiki contiene tres rutas de aprendizaje vinculadas. La primera version debe tener aproximadamente 18 nodos: tres mapas de ruta y cinco conceptos por ruta.

### Ruta 1: Grafos de conocimiento y conocimiento local

- Markdown y YAML como fuente de verdad.
- Wikilinks, relaciones y procedencia.
- Retrieval, busqueda y contexto.
- Huérfanos, huecos y conexiones debiles.
- Como los grafos ayudan a la navegacion humana y agéntica.

### Ruta 2: Software agéntico

- Diferencia entre un chat y un agente.
- Herramientas, MCP y permisos.
- Sistemas locales e interoperabilidad.
- Automatizacion con aprobacion humana.
- Construccion de herramientas para individuos o equipos.

### Ruta 3: Skills y flujos modulares

- Que es un skill.
- Cuando extraer un flujo a un skill.
- Inputs, outputs y contratos.
- Composicion de habilidades como engranajes.
- Flujos humano-agente y puntos de aprobacion.

Cada nota semilla debe incluir fuentes publicas y una licencia o condicion de uso verificable. El material no se presenta como memoria personal ni como verdad cerrada. El usuario puede editarlo, retirarlo o ampliar sus conexiones.

## Criterio de curacion del paquete semilla

El paquete no debe ser una coleccion de articulos copiados ni un curso encubierto. Debe ofrecer un primer mapa que sea util por si mismo y que demuestre como se conectan las ideas.

1. Cada nodo enseña una idea durable y accionable, no una noticia ni una definicion aislada.
2. Cada ruta tiene una pregunta guia y una accion posible dentro de Sinapso.
3. Cada afirmacion importante enlaza a una fuente publica y estable: documentacion oficial, trabajo original, estandar abierto o articulo tecnico de alta calidad.
4. Las notas sintetizan en palabras propias. No reproducen contenido protegido salvo citas breves y atribuidas.
5. Cada nota tiene al menos dos conexiones: una dentro de su ruta y una con otra ruta.
6. El paquete explica sus limites y deja preguntas abiertas. Su objetivo es iniciar exploracion, no imponer una doctrina.
7. La curacion se valida antes de distribuirla: fuente, licencia o condiciones de uso, fecha de revision, claridad y utilidad para una primera sesion.

La seleccion de fuentes exactas se hace de forma editorial antes de implementarla. Cada fuente se registra como procedencia del paquete, no como dependencia de red para abrir el baul.

## Uso de LLM y proveedores

### Sin LLM

Sinapso debe poder hacer lo siguiente de manera local:

- crear estructura desde plantillas aprobadas;
- escanear el baul y visualizar el grafo;
- importar y convertir archivos mediante MarkItDown;
- ejecutar busqueda literal y capacidades locales de QMD cuando esten instaladas;
- detectar estructura, enlaces rotos, huérfanos y gaps topologicos;
- instalar el paquete semilla;
- mostrar un diagnostico y propuestas estructurales deterministas.

### LLM gratuito u opcional

El LLM aparece cuando el usuario quiere adaptar la estructura a sus respuestas, convertir una importacion en propuesta de wiki, generar conexiones sugeridas o redactar una sintesis. Todas las escrituras se presentan como preview y requieren aprobacion.

OpenRouter ofrece el router `openrouter/free`, que selecciona un modelo gratuito compatible con la tarea. A la fecha de esta investigacion, su plan gratuito publica 50 solicitudes por dia sin creditos comprados. Requiere cuenta y API key, puede cambiar de modelo, tiene disponibilidad variable y no es apropiado para operaciones confiables o automaticas.

El modo gratuito es adecuado para experimentar y para propuestas pequeñas. Los modelos pagados o locales se presentan despues como mejoras de confiabilidad, privacidad, capacidad o volumen, nunca como requisito para abrir el primer baul.

Fuentes:

- [OpenRouter Free Models Router](https://openrouter.ai/docs/guides/routing/routers/free-router)
- [OpenRouter Pricing](https://openrouter.ai/pricing)
- [OpenRouter Limits](https://openrouter.ai/docs/api/reference/limits)

## Dream cycle manual de v1

La v1 incorpora el boton **Revisar y enriquecer mi baul**. Es una ejecucion manual, visible y aprobable del dream cycle.

1. Inspecciona cambios desde la ultima revision, fuentes nuevas, enlaces rotos, notas huerfanas, clusters debiles y relaciones potenciales.
2. Sin LLM, muestra hallazgos estructurales locales y acciones deterministas.
3. Con LLM configurado, produce propuestas de conexiones, sintesis, consolidacion, paginas wiki o preguntas de investigacion.
4. Muestra un resumen visible, por ejemplo: conexiones encontradas, huecos detectados, fuentes pendientes y propuestas generadas.
5. El usuario selecciona que propuestas aplicar.
6. Sinapso escribe solo cambios aprobados y registra la revision.

El ciclo no investiga en la web, modifica notas ni ejecuta procesos en segundo plano sin una accion expresa del usuario.

## Distribucion e interoperabilidad

El resultado no debe ser solamente un skill. La fuente de verdad debe ser una especificacion de onboarding, contratos y paquetes semilla que tiene dos ejecutores:

- **Sinapso:** experiencia visual, escaneo local, previews, aprobaciones, aplicacion de cambios y grafo.
- **Skill de bootstrap:** ruta para OpenCode, Pi, Claude Code, Codex y otros hosts que ya use una persona.

Cada host recibe un instalador o integracion propia. El MCP de Sinapso ofrece operaciones compartidas, pero no reemplaza la experiencia de instalacion, permisos o contexto de cada host.

## Limite de la v1

La v1 esta completa cuando una persona puede:

1. crear o mejorar un baul desde Sinapso;
2. aprobar una estructura inicial;
3. tener archivos raiz de identidad y limites;
4. importar una wiki semilla de IA con fuentes y relaciones;
5. navegar el grafo localmente;
6. importar una primera fuente sin LLM;
7. conectar de forma opcional un LLM gratuito, local o pagado;
8. recibir y aprobar propuestas de enriquecimiento;
9. ejecutar manualmente el boton de dream cycle y aplicar sus resultados seleccionados.

## Fuera de alcance inicial

- Cronjobs y scheduler recurrente.
- Heartbeat autonomo.
- Hosting de agentes.
- Sincronizacion multi-dispositivo o servicio gestionado.
- Memoria conversacional cross-host.
- Investigacion web automatica.
- Escrituras automaticas sin aprobacion.

## Decisiones pendientes

1. Curar y validar las fuentes exactas para los 18 nodos del paquete semilla.
2. Definir la sintaxis exacta de `AGENTS.md` para el mapa de carga de contexto por operacion.
3. Elegir si `PROJECTS.md` se crea desde el primer dia o solo al crecer la cantidad de proyectos.
4. Diseñar la interfaz del diagnostico, mapa de migracion y boton de dream cycle.
5. Convertir este brainstorm en una especificacion de producto y luego en plan de implementacion del repositorio Sinapso.

# Flow Automation V0.1.3 (prototype)

Extension Chrome Manifest V3 indépendante pour automatiser la génération de contenu
sur [Google Flow](https://flow.google.com) — de façon **transparente et fiable**,
sans contournement, sans serveur externe, sans secret de l'extension d'origine.

> **Cible prioritaire : Quetta Browser sur Android 12** (fork Chromium MV3).
> Chrome Desktop reste supporté.

> V0.1.2 a rendu la réinjection **idempotente** et les sélecteurs **rafraîchis** à
> la mise à jour. V0.1.3 = **détection robuste du bouton d'envoi** + repli clavier,
> et diagnostic qui **liste les éléments interactifs** de la page.

---

## Nouveautés V0.1.3 (détection du bouton d'envoi)

Sur le projet réel, le diagnostic renvoyait `bouton générer : NON` alors que le
champ prompt était détecté. Les sélecteurs nommés (`jsaction*=submit`, etc.) ne
correspondaient à rien sur le site. Correction :

1. **Détection du bouton en 3 niveaux** (du plus fiable au plus large) :
   - **nommé** : `data-test-id`/`aria-label` = `submit|send|generate|create`,
     `jsaction*=submit`, `type=submit` ;
   - **structurel** : `form button:not([disabled])`, `[role=button]`,
     `button:has(mat-icon)`, `button:has(svg/i)` — Flow utilise **Angular Material**
     (`<button class="flow-button-*">` avec `<mat-icon>`) ;
   - **contextuel** : si un seul élément cliquable visible, ou le bouton visible
     le plus **proche du champ prompt** (< 400 px).
   Les boutons `disabled` sont écartés à chaque niveau.
2. **Repli clavier « Entrée »** : si aucun bouton n'est identifiable **mais que le
   champ contient du texte**, `dom.submitPrompt()` envoie `keydown/keypress/keyup`
   `Enter` sur le champ (comportement courant des zones de saisie de type chat).
   Le repli **ne s'applique jamais** à un champ vide (on ne « clique pas dans le vide »).
3. **Diagnostic enrichi** : la section PAGE indique la **voie** de détection
   (`bouton générer : NON (via named)`) et une section
   **ÉLÉMENTS INTERACTIFS VISIBLES** liste les `button / [role=button] / a / mat-icon`
   réellement présents (avec `aria-label`, `data-test-id`, `jsaction`, texte).
   Objectif : **ne plus deviner** — on voit ce qui existe pour fixer le sélecteur.

`selectors.json` passe en **version 2** (familles élargies + `fallbacks`).

## Correctifs V0.1.2

1. **Réinjection idempotente** — réévaluer les scripts ne doit rien casser :
   - `queue-manager.js` ne **réinitialise plus** l'état de la file s'il est déjà
     chargé (une file en cours n'est plus perdue silencieusement) ;
   - `content.js` ne **réenregistre plus** de second écouteur de messages : la
     garde `window.__FLOW_AUTOMATION_LOADED__` renvoie immédiatement.
2. **Sélecteurs rafraîchis à la mise à jour** — `selectors.json` est comparé par
   **empreinte** (`fingerprint`) et remplacé à l'installation/mise à jour si le
   fichier livré a changé.

---

## Correctifs V0.1.1

### Cause racine du bug « Onglet Flow non prêt » (corrigée)

Le content script était **incorrectement livré** : `content.js` contenait encore
les préfixes de numéros de ligne (`1: /**`, `2:  * …`), ce qui provoquait
`SyntaxError: Unexpected token ':'`. Le script ne s'exécutait donc **jamais**
dans l'onglet Flow : aucun écouteur de messages n'était enregistré, `tabs.sendMessage`
ne recevait aucune réponse, et le popup affichait un message générique.

- `content.js` réécrit proprement (lignes dé-prefixées).
- Vérification automatique de syntaxe de tous les fichiers dans les tests.
- **Réinjection contrôlée** : si le content script est absent, le service worker le
  réinjecte via `chrome.scripting.executeScript` (une seule tentative par onglet,
  garde anti-boucle de 5 s).

### Autres correctifs

- **États distincts** au lieu d'un message unique : `API_UNAVAILABLE`,
  `NO_TAB`, `NOT_FLOW`, `TAB_LOADING`, `CONTENT_ABSENT`, `CONTENT_NO_RESPONSE`,
  `TAB_COMM_ERROR`, `FLOW_NOT_PROJECT`, `PROJECT_LOADING`, `PROJECT_NO_PROMPT`,
  `PROMPT_NO_SUBMIT`, `READY` (logique pure dans `status.js`).
- **Bouton « Diagnostic »** : enchaîne API → onglet → content script → état de la
  page et affiche un rapport copiable (pour transmission).
- **Bouton « Démarrer » réparé** : vérifie l'état réel, refuse explicitement si
  une condition manque, et **confirme par `QUEUE_GET`** que la file tourne
  vraiment — il ne prétend jamais qu'une génération a commencé sinon.
- **Logs exploitables** : popup ouvert, onglet trouvé, URL détectée, présence du
  content script, envoi/réponse de vérification, champ prompt, bouton de
  génération, erreur précise. Aucun `try/catch` silencieux.
- **Compatibilité Quetta** : couche `chrome`/`browser` propagée partout ;
  service worker en script classique (sans `type: module`) pour les forks ;
  recherche d'onglet robuste (requête filtrée + repli global) ; popup responsive.

---

## Fonctionnalités

| # | Fonctionnalité | État |
|---|---|---|
| 1 | Détection de Google Flow + **état détaillé** | ✅ implémentée (états distincts) |
| 2 | Vérification projet / champ prompt présent | ✅ implémentée |
| 3 | Saisie de plusieurs prompts (un par ligne) | ✅ implémentée |
| 4 | Envoi séquentiel des prompts | ✅ implémentée |
| 5 | Attente réelle de fin de génération (multiples indices DOM) | ✅ implémentée (à valider sur site réel) |
| 6 | Identification des médias générés (video/img dans les tuiles) | ✅ implémentée (à valider) |
| 7 | Téléchargement des fichiers | ✅ implémentée via `chrome.downloads` |
| 8 | Association résultat → prompt (nom de fichier `NNN_slug.ext`) | ✅ implémentée |
| 9 | Persistance de la file + reprise après interruption | ✅ implémentée |
| 10 | Pause / Reprendre / Annuler | ✅ implémentées |
| 11 | Historique des résultats (`storage.results`) | ✅ implémentée |
| 12 | **Diagnostic intégré** (rapport copiable) | ✅ implémenté |
| 13 | **Réinjection contrôlée** du content script | ✅ implémentée |
| — | Application des paramètres Modèle / Ratio / Nombre | ⏳ prévue mais **désactivée** (à tester) |

## Installation (développement)

1. Ouvrir le gestionnaire d'extensions du navigateur
   (Quetta : menu → Extensions ; Chrome : `chrome://extensions`).
2. Activer le **mode développeur**.
3. **« Charger l'extension non empaquetée »** et sélectionner le dossier du projet
   (celui contenant `manifest.json`).
4. Ouvrir un onglet sur `flow.google.com`, être connecté et **dans un projet**
   (URL contenant `/project/…`).
5. Ouvrir la popup. Cliquer **« Diagnostic »** pour vérifier la chaîne, puis saisir
   les prompts et cliquer **Démarrer**.

> Si une ancienne version est installée, la **désinstaller puis réinstaller** pour
> purger le content script mis en cache.

### ZIP installable

Un ZIP avec `manifest.json` à la racine est fourni (voir la section Livraison).

## Architecture

```
manifest.json          Manifest V3 (permissions : storage, downloads, tabs, scripting, activeTab)
background.js          Service worker : recherche d'onglet, réinjection contrôlée, diagnostic, relais, téléchargements
status.js              Logique PURE de l'état Flow (testable hors navigateur)
content.js             Content script : pipeline d'un prompt + orchestration
flow-dom.js            Détection/manipulation du DOM (pure, sans API extension)
generation-manager.js  Suivi des générations, détection de fin (multi-indices)
queue-manager.js       File d'attente séquentielle + persistance + reprise
download-manager.js    Téléchargement des médias + nommage
storage-manager.js     Persistance chrome.storage.local
selectors.json         Sélecteurs locaux versionnés (à ajuster sur site réel)
popup.html / .css / .js  Interface mobile (statut détaillé + diagnostic)
```

### Pipeline d'un prompt

```
IDLE → PREPARING → SUBMITTING → GENERATING → DETECTING_RESULT → DOWNLOADING → COMPLETED
        |→ ERROR / TIMEOUT / CANCELLED / WAITING_FOR_USER
```

Chaque transition est journalisée (`storage.logs`, affichée dans la popup).

### Chaîne de communication (vérifiée)

```
Popup ──GET_ACTIVE_FLOW_TAB──► Background ──tabs.query──► Onglet Flow
Popup ──ENSURE_CONTENT───────► Background ──PING / scripting.executeScript──► Content script
Popup ──GET_PAGE_STATE───────► Content script ──► DOM Google Flow
```

Chaque maillon renvoie un échec **explicite** (jamais un message générique unique).

### Règles de fiabilité

- Une génération n'est **jamais** considérée terminée parce que le bouton a été
  cliqué ou le champ vidé.
- Fin détectée par **plusieurs indices** : nouvelle tuile, média `video`/`img`,
  stabilité sur plusieurs contrôles, absence de barre de progression.
- **Jamais** de nouvelle génération après un échec de téléchargement.
- Une seule génération à la fois (séquentiel strict).
- **Jamais** de démarrage annoncé sans confirmation réelle (`QUEUE_GET`).

## Limites connues de V0.1.3

1. **Sélecteurs DOM non validés sur le site réel.** Le DOM de flow.google.com est
   généré dynamiquement (Angular) et n'est pas inspectable hors navigateur
   connecté. Les sélecteurs (`selectors.json`) sont des hypothèses documentées
   (`confidence`). Le bouton d'envoi dispose désormais de **3 niveaux de détection
   + repli Entrée**, mais si `hasSubmit = NON`, la section **ÉLÉMENTS INTERACTIFS
   VISIBLES** du diagnostic permet de fixer le sélecteur exact sans deviner.
2. **Paramètres Modèle/Ratio/Nombre non appliqués** : présents dans l'UI et
   persistés, mais non appliqués à Google Flow dans cette version.
3. **Vérification d'accès média** : le `fetch` du content script peut être bloqué
   par CORS ; le téléchargement est alors tenté directement (le background a les
   permissions host).
4. **Réinjection du content script** : dépend de `chrome.scripting.executeScript`.
   Si Quetta ne l'expose pas, le diagnostic l'affiche (`scripting: NON`,
   `injectError`). La déclaration `content_scripts` du manifeste reste la voie
   normale ; la réinjection n'est qu'un filet de sécurité.
5. **Tests réels sur Quetta/Chrome non exécutés ici** (aucun navigateur
   pilotable dans l'environnement de développement). Voir « Tests ».

## Tests (état réel)

### Résultats des tests simulés (réellement exécutés)

Six suites de tests unitaires **simulés** existent et ont été exécutées avec
Node.js (hors navigateur) :

```bash
node tests/simulate.js             # → Passed: 13 / Failed: 0
node tests/queue-simulate.js       # → Passed: 24 / Failed: 0
node tests/status-simulate.js      # → Passed: 32 / Failed: 0
node tests/start-flow-simulate.js  # → Passed: 26 / Failed: 0
node tests/reinject-simulate.js    # → Passed: 16 / Failed: 0
node tests/submit-simulate.js      # → Passed: 19 / Failed: 0
```

| Suite | Ce qui est testé | Résultat |
|---|---|---|
| `tests/simulate.js` | `flow-dom` : détection de page, lecture/écriture du prompt ; `generation-manager` : snapshot, `waitForCompletion` (ok/timeout/annulé), `checkMediaAccess` | ✅ 13/13 |
| `tests/queue-simulate.js` | `download` : slugify, buildFilename, vérification d'accès (CORS/HTTP) ; `queue` : création, persistance, exécution séquentielle, restauration, pause/reprise | ✅ 24/24 |
| `tests/status-simulate.js` | `status.js` : **les 11 scénarios** — URL exacte fournie, Flow sans projet, projet, chargement, content absent, content présent, message sans réponse, API indisponible, aucun onglet/mauvais site, DOM incomplet, erreur de communication | ✅ 32/32 |
| `tests/start-flow-simulate.js` | Parcours **Démarrer** : aucun prompt, démarrage valide, multi-prompts, refus si page non prête / content absent / sans réponse / API absente / pas d'onglet, **file inactive ≠ démarré**, erreurs de création et de `tabs.query` | ✅ 26/26 |
| `tests/reinject-simulate.js` | **Réinjection** : double évaluation des scripts, survie de la file d'attente, unicité de l'écouteur de messages, réponse de l'écouteur après réinjection | ✅ 16/16 |
| `tests/submit-simulate.js` | **Détection du bouton d'envoi** : niveaux nommé/structurel/contextuel, bouton désactivé écarté, repli clavier Entrée (champ rempli), échec explicite (champ vide), `describeInteractiveElements` | ✅ 19/19 |

> ⚠️ Ces tests **ne valident pas** le comportement réel de Google Flow (DOM et API
> simulés). Ils vérifient la logique, pas les sélecteurs du site ni Quetta.

### Tests nécessitant un navigateur connecté à flow.google.com (NON exécutés ici)

Aucun navigateur n'est disponible dans l'environnement de développement ; à
exécuter **manuellement** (Quetta Android ou Chrome) :

1. **Diagnostic** : popup → « Diagnostic » doit indiquer `runtime`, `tabs`,
   `scripting`, `downloads`, `storage` = OUI, l'onglet Flow, `contentPresent` = OUI,
   `hasPrompt` = OUI, `hasSubmit` = OUI, verdict `READY`. En cas de
   `bouton générer : NON`, la section **ÉLÉMENTS INTERACTIFS VISIBLES** doit être
   transmise : elle montre les `aria-label`/`data-test-id` réels de la page.
2. Détection de Google Flow (popup affiche « Prêt à générer »).
3. Envoi d'un prompt et attente de la fin d'une génération réelle.
4. Détection d'une génération terminée (multiples tuiles, médias stables).
5. Téléchargement d'un média (`NNN_slug.mp4/jpg`).
6. Exécution de 3 prompts successifs (séquentiel).
7. Pause / reprise (entre deux prompts).
8. Interruption (fermeture navigateur) puis restauration : `WAITING_FOR_USER`,
   aucune génération relancée.
9. Échec de téléchargement : résultat conservé, **pas** de nouvelle génération.
10. Prompts vides / lignes blanches → refus explicite.

**En cas d'échec**, transmettre le **rapport de diagnostic** copié depuis la popup.

## Compatibilité Quetta Browser (Android)

| API / mécanisme | Statut |
|---|---|
| `chrome.runtime` / `chrome.storage` / `chrome.tabs` | ✅ utilisés (couche `chrome` prioritaire, repli `browser`) |
| `chrome.downloads` | ✅ utilisé ; si absent, le diagnostic l'indique (le téléchargement échouerait alors) |
| `chrome.scripting.executeScript` | ⚠️ utilisé **en filet de sécurité** ; si absent, indiqué dans le diagnostic |
| `content_scripts` (manifest) | voie normale, dépend du respect du manifeste par le fork |
| Service worker `type: module` | retiré (script classique) pour maximiser la compatibilité |
| Popup | largeur responsive (`min-width: 300px`, `max-width: 100vw`) |

Chrome Desktop reste entièrement supporté.

## Étapes suivantes (roadmap)

- **V0.1-B→E** : valider sur site réel les sélecteurs, la fin de génération, le
  téléchargement, et la reprise (voir liste des tests manuels).
- **V0.2** : application vérifiée des paramètres Modèle / Ratio / Nombre, une
  option à la fois, avec vérification après application et arrêt du prompt en cas
  d'échec.

## Sécurité & principes

- Aucun serveur de configuration externe.
- Aucun secret de l'extension d'origine.
- Aucun mécanisme de dissimulation/anti-détection, aucun mouvement de souris
  artificiel, aucun `chrome.debugger`.
- Aucune API privée non documentée de Google : le code manipule uniquement le DOM
  public de l'application.
- Les prompts et résultats restent en local (`chrome.storage.local`).

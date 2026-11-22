# Flow Automation V0.1.5 (prototype)

Extension Chrome Manifest V3 indépendante pour automatiser la génération de contenu
sur [Google Flow](https://flow.google.com) — de façon **transparente et fiable**,
sans contournement, sans serveur externe, sans secret de l'extension d'origine.

> **Cible prioritaire : Quetta Browser sur Android 12** (fork Chromium MV3).
> Chrome Desktop reste supporté.

> V0.1.4 a trouvé **le bon bouton** (`aria-label="Lancer la génération"`,
> `type=submit`) mais **le clic ne déclenchait rien**. V0.1.5 corrige
> l'**actionnement** : saisie `contenteditable` compatible Angular, clic avec geste
> souris complet + clic natif, journalisation fiabilisée, **logs copiables**.

---

## Nouveautés V0.1.5 (le clic déclenche vraiment la génération)

Diagnostic réel : le bouton retenu est **exactement le bon**
(`button[aria-label="Lancer la génération" type="submit"]{arrow_forward}`), le champ
contient le prompt… mais **la génération ne démarre jamais**, et la ligne
« Soumission du prompt » **manquait** dans les logs. Trois causes racines corrigées :

1. **Saisie `contenteditable` compatible Angular** (`dom.setPromptText`) : une
   affectation `textContent` + `Event('input')` ne transporte ni `inputType` ni
   `data` ; Angular garde alors son modèle **vide** et le bouton d'envoi reste
   **désactivé** (donc aucun clic n'a d'effet). On utilise désormais
   `execCommand('insertText')` (vrai `InputEvent`) avec repli manuel émettant
   `beforeinput` + `input` porteurs de `inputType: 'insertText'` et `data`, plus
   `focus()`, `change`, `blur`.
2. **Clic réaliste** (`dom.click`) : geste souris complet
   (`pointerdown/mousedown/pointerup/mouseup`) **puis** un **seul** `el.click()`
   natif — qui déclenche à la fois le listener Angular **et** l'action par défaut
   du bouton (`type=submit`), ce qu'un `MouseEvent` synthétique ne fait pas.
3. **Journalisation fiabilisée** : `appendLog` (storage) sérialise ses écritures.
   Avant, deux logs rapprochés lisaient la même liste et le second **écrasait** le
   premier — d'où la disparition de la ligne « Soumission ». Le pipeline journalise
   maintenant la voie d'envoi, la correspondance du texte écrit et l'état du bouton.

**Logs copiables** : bouton **« Copier les logs »**, et sélection de texte activée
sur la zone de logs et le rapport de diagnostic. Le diagnostic ajoute les lignes
`bouton actif : OUI/NON` (détecte un bouton désactivé) et le nombre de caractères
présents dans le champ.

## Nouveautés V0.1.4 (le BON bouton d'envoi)

`bouton générer : OUI (via named)` mais **le prompt se colle et rien ne démarre**.
Cause : le bouton retenu était le **premier** du DOM correspondant à un sélecteur
nommé (ex. bouton de menu), pas le bouton d'envoi. Corrections :

1. **Sélection par score, pas « premier trouvé »** (`dom.scoreSubmitCandidate`) :
   on construit un **ensemble candidat** = sélecteurs nommés ∪ replis structurels
   ∪ éléments cliquables **proches du champ prompt** (< 400 px), puis on retient le
   meilleur score. Score favorise : icône **flèche/envoi** (`arrow_forward`, `send`,
   `enter`), libellé `send|submit|arrow|enter`, position **à droite du champ** et
   dans sa bande verticale, proximité. Score pénalise : `add|search|filter|help|
   home|more|menu|delete|download|...` et les boutons `disabled`.
2. **Détection d'un non-démarrage** : après soumission, si **aucun signe** de
   génération n'apparaît (pas de nouvelle tuile, pas de progression, nombre de
   médias inchangé) pendant `generationStartMs` (12 s), on échoue **vite et
   franchement** (« La génération n'a pas démarré… bouton d'envoi probablement pas
   actionné ») au lieu d'attendre le timeout complet de 180 s.
3. **Diagnostic complet** : section **BOUTONS PRÈS DU CHAMP PROMPT (<400px)**
   (distance + description), ligne **bouton retenu** (description + score), et
   liste **ÉLÉMENTS INTERACTIFS VISIBLES** complète (60 éléments, champ prompt
   marqué `<<< PROMPT`).

## Nouveautés V0.1.3 (détection du bouton d'envoi)

Premier correctif sur le bouton : détection en 3 niveaux (nommé / structurel /
contextuel), **repli clavier « Entrée »** quand le champ est rempli mais que le
bouton n'est pas identifiable (jamais sur champ vide), et première version du
diagnostic listant les éléments interactifs. `selectors.json` v2 (familles
élargies + `fallbacks`).

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

## Limites connues de V0.1.5

1. **Sélecteurs DOM non validés sur le site réel.** Le DOM de flow.google.com est
   généré dynamiquement (Angular) et n'est pas inspectable hors navigateur
   connecté. Les sélecteurs (`selectors.json`) sont des hypothèses documentées
   (`confidence`). Le bouton d'envoi est choisi par **score** (icône flèche +
   position près du champ) parmi un ensemble candidat élargi, avec **repli Entrée** ;
   le diagnostic affiche **le bouton retenu**, **son score** et les **boutons près
   du champ** pour fixer le sélecteur exact sans deviner. Si le bon bouton n'est ni
   nommé ni proche du champ, un ajustement manuel de `selectors.json` reste possible.
2. **Paramètres Modèle/Ratio/Nombre non appliqués** : présents dans l'UI et
   persistés, mais non appliqués à Google Flow dans cette version.
3. **Vérification d'accès média** : le `fetch` du content script peut être bloqué
   par CORS ; le téléchargement est alors tenté directement (le background a les
   permissions host).
4. **Détection de non-démarrage** : heuristique (aucune nouvelle tuile / progression
   / média pendant 12 s). Un délai serveur inhabituellement long avant le premier
   signe visuel pourrait déclencher un faux « non démarré » ; la valeur
   `generationStartMs` est réglable dans `selectors.json`.
4. **Réinjection du content script** : dépend de `chrome.scripting.executeScript`.
   Si Quetta ne l'expose pas, le diagnostic l'affiche (`scripting: NON`,
   `injectError`). La déclaration `content_scripts` du manifeste reste la voie
   normale ; la réinjection n'est qu'un filet de sécurité.
5. **Tests réels sur Quetta/Chrome non exécutés ici** (aucun navigateur
   pilotable dans l'environnement de développement). Voir « Tests ».
6. **Actionnement non validé sur le site réel** : la saisie compatible Angular
   (`execCommand('insertText')` + `InputEvent`) et le clic (geste souris + clic
   natif) sont des **hypothèses raisonnées**, pas une preuve. Si le bouton reste
   désactivé, la ligne `bouton actif : NON` du diagnostic le confirmera — il
   faudra alors inspecter les événements réellement attendus par le champ.

## Tests (état réel)

### Résultats des tests simulés (réellement exécutés)

Six suites de tests unitaires **simulés** existent et ont été exécutées avec
Node.js (hors navigateur) :

```bash
node tests/simulate.js             # → Passed: 15 / Failed: 0
node tests/queue-simulate.js       # → Passed: 24 / Failed: 0
node tests/status-simulate.js      # → Passed: 32 / Failed: 0
node tests/start-flow-simulate.js  # → Passed: 26 / Failed: 0
node tests/reinject-simulate.js    # → Passed: 16 / Failed: 0
node tests/submit-simulate.js      # → Passed: 31 / Failed: 0
```

| Suite | Ce qui est testé | Résultat |
|---|---|---|
| `tests/simulate.js` | `flow-dom` : détection de page, lecture/écriture du prompt ; `generation-manager` : snapshot, `waitForCompletion` (ok/timeout/annulé/**non-démarré**), `checkMediaAccess` | ✅ 15/15 |
| `tests/queue-simulate.js` | `download` : slugify, buildFilename, vérification d'accès (CORS/HTTP) ; `queue` : création, persistance, exécution séquentielle, restauration, pause/reprise | ✅ 24/24 |
| `tests/status-simulate.js` | `status.js` : **les 11 scénarios** — URL exacte fournie, Flow sans projet, projet, chargement, content absent, content présent, message sans réponse, API indisponible, aucun onglet/mauvais site, DOM incomplet, erreur de communication | ✅ 32/32 |
| `tests/start-flow-simulate.js` | Parcours **Démarrer** : aucun prompt, démarrage valide, multi-prompts, refus si page non prête / content absent / sans réponse / API absente / pas d'onglet, **file inactive ≠ démarré**, erreurs de création et de `tabs.query` | ✅ 26/26 |
| `tests/reinject-simulate.js` | **Réinjection** : double évaluation des scripts, survie de la file d'attente, unicité de l'écouteur de messages, réponse de l'écouteur après réinjection | ✅ 16/16 |
| `tests/submit-simulate.js` | **Actionnement de l'envoi** : niveaux nommé/structurel/contextuel, bouton désactivé, repli clavier Entrée, échec explicite (champ vide), **sélection par score**, **`setPromptText` émet un vrai `input` porteur de `data`**, **`dom.click` fait le geste souris + un seul clic natif**, `describeInteractiveElements` | ✅ 31/31 |

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

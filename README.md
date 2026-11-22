# Flow Automation V0.1 (prototype)

Extension Chrome Manifest V3 indépendante pour automatiser la génération de contenu
sur [Google Flow](https://flow.google.com) — de façon **transparente et fiable**,
sans contournement, sans serveur externe, sans secret de l'extension d'origine.

> Projet de développement par étapes. V0.1 = preuve de concept : file d'attente
> séquentielle de prompts, attente réelle de fin de génération, détection des
> médias, téléchargement, persistance et reprise.

---

## Fonctionnalités

| # | Fonctionnalité | État |
|---|---|---|
| 1 | Détection de Google Flow (`flow.google.com`) | ✅ implémentée (statut affiché dans la popup) |
| 2 | Vérification que l'utilisateur est dans un projet (champ prompt présent) | ✅ implémentée |
| 3 | Saisie de plusieurs prompts (un par ligne) | ✅ implémentée |
| 4 | Envoi séquentiel des prompts | ✅ implémentée |
| 5 | Attente réelle de fin de génération (multiples indices DOM) | ✅ implémentée (à valider sur site réel) |
| 6 | Identification des médias générés (video/img dans les tuiles) | ✅ implémentée (à valider) |
| 7 | Téléchargement des fichiers | ✅ implémentée via `chrome.downloads` |
| 8 | Association résultat → prompt (nom de fichier `NNN_slug.ext`) | ✅ implémentée |
| 9 | Persistance de la file + reprise après interruption | ✅ implémentée |
| — | Pause / Reprendre / Annuler | ✅ implémentées |
| — | Historique des résultats (`storage.results`) | ✅ implémentée |
| — | Application des paramètres Modèle / Ratio / Nombre | ⏳ prévue mais **désactivée** (à tester) |

## Installation (développement)

1. Ouvrir `chrome://extensions` (ou le gestionnaire d'extensions du navigateur
   compatible — ex. Quetta).
2. Activer le **mode développeur**.
3. Cliquer **« Charger l'extension non empaquetée »** et sélectionner le dossier
   du projet (celui contenant `manifest.json`).
4. Ouvrir un onglet sur `flow.google.com`, s'assurer d'être connecté et dans un
   projet.
5. Cliquer l'icône de l'extension, saisir les prompts, cliquer **Démarrer**.

### ZIP installable

Un ZIP avec `manifest.json` à la racine est fourni (voir la section Livraison).

## Architecture

```
manifest.json          Manifest V3 (permissions minimales)
background.js          Service worker : relais de messages + téléchargements
content.js             Content script : pipeline d'un prompt + orchestration
flow-dom.js            Détection/manipulation du DOM (pure, sans API extension)
generation-manager.js  Suivi des générations, détection de fin (multi-indices)
queue-manager.js       File d'attente séquentielle + persistance + reprise
download-manager.js    Téléchargement des médias + nommage
storage-manager.js     Persistance chrome.storage.local
selectors.json         Sélecteurs locaux versionnés (à ajuster sur site réel)
popup.html / .css / .js  Interface mobile
```

### Pipeline d'un prompt

```
IDLE → PREPARING → SUBMITTING → GENERATING → DETECTING_RESULT → DOWNLOADING → COMPLETED
        |→ ERROR / TIMEOUT / CANCELLED / WAITING_FOR_USER
```

Chaque transition est journalisée (`storage.logs`, affichée dans la popup).

### Règles de fiabilité (V0.1)

- Une génération n'est **jamais** considérée terminée parce que le bouton a été
  cliqué ou le champ vidé.
- La fin de génération est détectée par **plusieurs indices** : augmentation du
  nombre de tuiles, apparition d'un média `video`/`img`, stabilité de la ressource
  sur plusieurs contrôles espacés, absence de barre de progression.
- Un média est téléchargé seulement après vérification d'accès best-effort.
- Si le téléchargement échoue, le résultat est conservé (URL) et une relance
  manuelle est possible — **jamais** de nouvelle génération automatique.
- Une seule génération à la fois (séquentiel strict) : aucun doublon de
  soumission même si la première réponse est lente.

## Limites connues de V0.1

1. **Sélecteurs DOM non validés sur le site réel.** Le DOM applicatif de
   flow.google.com est généré dynamiquement (Angular) et ne peut pas être
   inspecté hors d'un navigateur connecté. Les sélecteurs actuels
   (`selectors.json`) sont des hypothèses documentées (`confidence`) basées sur
   l'analyse du bundle Angular et de l'extension d'origine. **À ajuster** via
   l'inspection manuelle (F12 → copier sélecteur) en cas d'échec de détection.
2. **Paramètres Modèle/Ratio/Nombre non appliqués** : présents dans l'UI et
   persistés, mais l'application sur Google Flow n'est pas implémentée ni testée
   (voir « Étapes suivantes »).
3. **Vérification d'accès média** : le fetch du content script peut être bloqué
   par CORS ; dans ce cas le téléchargement est tenté directement (le background
   a les permissions host). Résultat non garanti avant test réel.
4. **Quetta / navigateurs Android** : le code utilise `chrome.*` ; une couche
   d'adaptation (`api = browser || chrome`) est amorcée dans `background.js` et
   `popup.js` mais non testée sur Quetta.
5. **Tests** : les tests simulés (2 suites, 37 assertions) passent ; les tests sur
   navigateur réel (voir « Tests ») n'ont pas pu être exécutés ici.
6. **Sélecteurs** : `selectors.json` est désormais réellement chargé par le
   service worker (`fetch(runtime.getURL('selectors.json'))`) et non plus
   dupliqué en dur. L'utilisateur peut donc ajuster ce fichier sans toucher au
   code (recharger l'extension ensuite).

## Tests (état réel)

### Résultats des tests simulés (réellement exécutés)

Deux suites de tests unitaires **simulés** existent et ont été exécutées avec
Node.js (hors navigateur) :

```bash
node tests/simulate.js        # → Passed: 13 / Failed: 0
node tests/queue-simulate.js  # → Passed: 24 / Failed: 0
```

| Suite | Ce qui est testé | Résultat |
|---|---|---|
| `tests/simulate.js` | `flow-dom` : détection de page, lecture/écriture du prompt ; `generation-manager` : snapshot, `waitForCompletion` (ok / timeout / annulé), `checkMediaAccess` | ✅ 13/13 |
| `tests/queue-simulate.js` | `download` : slugify, buildFilename, vérification d'accès (CORS vs HTTP 404 vs 200) ; `queue` : création, persistance, exécution séquentielle, restauration, pause/reprise | ✅ 24/24 |

> ⚠️ Ces tests **ne valident pas** le comportement réel de Google Flow : le DOM
> y est simulé (mock). Ils vérifient la logique de l'extension (file, états,
> persistance, nommage, règles de décision), pas les sélecteurs du site.

### Tests nécessitant un navigateur connecté à flow.google.com (NON exécutés ici)

Aucun navigateur n'est disponible dans l'environnement de développement ; les
tests suivants restent **à exécuter manuellement** :

1. Détection de Google Flow (popup affiche « Prêt »).
2. Détection du champ de prompt (`hasPrompt`).
3. Envoi d'un prompt et attente de la fin d'une génération réelle.
4. Détection d'une génération terminée (multiples tuiles, médias stables).
5. Téléchargement d'un média (nommage `NNN_slug.mp4/jpg`).
6. Exécution de 3 prompts successifs (séquentiel).
7. Pause / reprise (entre deux prompts).
8. Interruption (fermeture navigateur) puis restauration : l'état revient en
   `WAITING_FOR_USER` et aucune génération n'est relancée.
9. Échec de téléchargement : résultat conservé, pas de nouvelle génération.
10. Prompts vides / lignes blanches.

## Étapes suivantes (roadmap)

- **V0.1-B** : ajuster `selectors.json` sur le site réel, valider l'écriture du
  prompt et le clic de soumission. *(fichier ajustable sans toucher au code)*
- **V0.1-C** : valider la détection de fin sur une génération réelle (temps,
  tuiles, stabilité).
- **V0.1-D** : valider le téléchargement (URLs googlevideo/lh3, CORS).
- **V0.1-E** : valider pause/reprise/restauration sur 3 prompts.
- **V0.1-F** : ✅ tests unitaires simulés écrits et exécutés (2 suites, 37 OK) ;
  stabilisation & nettoyage effectués.
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

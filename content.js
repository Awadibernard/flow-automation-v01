1: /**
2:  * content.js
3:  * Content script sur flow.google.com.
4:  *
5:  * Responsabilités :
6:  *  - charger selectors.json et configurer flow-dom / generation-manager
7:  *  - exposer le pipeline d'un prompt (processPrompt) au queue-manager
8:  *  - relayer les messages de la popup/background
9:  *
10:  * Pipeline d'un prompt (états) :
11:  *   PREPARING -> (vérifs page) -> SUBMITTING -> GENERATING ->
12:  *   DETECTING_RESULT -> DOWNLOADING -> COMPLETED
13:  *   |-> ERROR / TIMEOUT / CANCELLED
14:  *
15:  * Règles de fiabilité :
16:  *  - Ne jamais considérer une génération terminée parce que le bouton a été
17:  *    cliqué ou le champ vidé.
18:  *  - Ne jamais déclencher une deuxième génération si la première est en cours.
19:  */
20: 
21: (function () {
22:   'use strict';
23: 
24:   if (typeof window.FlowAutomation === 'undefined') {
25:     window.FlowAutomation = {};
26:   }
27: 
28:   const dom = window.FlowAutomation.dom;
29:   const generation = window.FlowAutomation.generation;
30:   const download = window.FlowAutomation.download;
31:   const queue = window.FlowAutomation.queue;
32:   const storage = window.FlowAutomation.storage;
33: 
34:   let selectorsConfig = null;
35: 
36:   // --- Chargement des sélecteurs ---
37:   async function loadSelectors() {
38:     try {
39:       const resp = await chrome.runtime.sendMessage({ type: 'GET_SELECTORS' });
40:       if (resp && resp.ok && resp.value) {
41:         selectorsConfig = resp.value;
42:         dom.setSelectors(selectorsConfig);
43:         if (selectorsConfig.durations) {
44:           generation.setConfig(selectorsConfig.durations);
45:         }
46:         storage.appendLog('info', 'Sélecteurs chargés (v' + (selectorsConfig.version || '?') + ')');
47:         return true;
48:       }
49:     } catch (e) {
50:       console.error('[content] loadSelectors failed', e);
51:     }
52:     storage.appendLog('warn', 'Sélecteurs indisponibles — utilisation des sélecteurs par défaut');
53:     dom.setSelectors({ selectors: {} });
54:     return false;
55:   }
56: 
57:   // --- Vérifications de la page ---
58:   function checkPage() {
59:     if (!dom.isFlowPage()) {
60:       return { ok: false, error: 'Page non reconnue comme Google Flow' };
61:     }
62:     if (!dom.hasPromptTextarea()) {
63:       return { ok: false, error: 'Champ de prompt introuvable — êtes-vous connecté et dans un projet ?' };
64:     }
65:     return { ok: true };
66:   }
67: 
68:   // --- Pipeline d'un prompt ---
69:   async function processPrompt(item, signal, log) {
70:     const promptText = item.prompt;
71: 
72:     // Vérifications de la page (WAITING_FOR_USER si problème)
73:     const pageCheck = checkPage();
74:     if (!pageCheck.ok) {
75:       return { status: 'WAITING_FOR_USER', error: pageCheck.error, medias: [] };
76:     }
77: 
78:     // Baseline avant soumission : état actuel des tuiles
79:     const baseline = generation.snapshot();
80:     log('info', `Baseline: ${baseline.count} tuile(s) présente(s)`);
81: 
82:     // 1. SUBMITTING — remplir le prompt
83:     item.status = 'SUBMITTING';
84:     queue.notify();
85:     log('info', 'Remplissage du prompt...');
86:     const filled = dom.setPromptText(promptText);
87:     if (!filled) {
88:       return { status: 'ERROR', error: 'Impossible d\'écrire dans le champ de prompt', medias: [] };
89:     }
90:     // vérifie que le texte a bien été pris en compte
91:     const written = dom.getPromptText();
92:     if (written.trim() !== promptText.trim()) {
93:       log('warn', 'Le texte du champ ne correspond pas exactement (normal si autocomplétion)');
94:     }
95: 
96:     // petit délai pour laisser l'UI réagir (pas de détection à contourner :
97:     // simple attente de rendu)
98:     await sleep(800);
99: 
100:     const submitBtn = dom.getSubmitButton();
101:     if (!submitBtn) {
102:       return { status: 'ERROR', error: 'Bouton de génération introuvable', medias: [] };
103:     }
104:     log('info', 'Soumission du prompt...');
105:     dom.click(submitBtn);
106: 
107:     // 2. GENERATING — attendre la fin réelle
108:     item.status = 'GENERATING';
109:     queue.notify();
110:     log('info', 'Génération en cours — attente de la fin (timeout ' +
111:       (generation.getConfig().generationTimeoutMs / 1000) + 's)');
112: 
113:     const completion = await generation.waitForCompletion(baseline, signal);
114:     if (completion.cancelled) {
115:       return { status: 'CANCELLED', error: 'Annulé par l\'utilisateur', medias: [] };
116:     }
117:     if (!completion.ok) {
118:       return {
119:         status: completion.timeout ? 'TIMEOUT' : 'ERROR',
120:         error: completion.error || 'Échec de détection du résultat',
121:         medias: []
122:       };
123:     }
124: 
125:     // 3. DETECTING_RESULT
126:     item.status = 'DETECTING_RESULT';
127:     queue.notify();
128:     log('info', completion.medias.length + ' média(s) détecté(s)');
129: 
130:     if (completion.medias.length === 0) {
131:       return { status: 'ERROR', error: 'Aucun média détecté après génération', medias: [] };
132:     }
133: 
134:     // 4. DOWNLOADING
135:     item.status = 'DOWNLOADING';
136:     queue.notify();
137: 
138:     const settings = await storage.get('settings');
139:     const dlResult = await download.downloadMedias(completion.medias, {
140:       promptIndex: parseInt(item.id.replace(/^p-\d+-/, ''), 10) || 0,
141:       prompt: item.prompt,
142:       folder: settings.downloadFolder || 'flow-automation',
143:       verifyAccess: true
144:     });
145: 
146:     const failed = dlResult.results.filter((r) => !r.ok);
147:     if (failed.length > 0) {
148:       log('error', failed.length + ' téléchargement(s) en échec — voir historique');
149:       return {
150:         status: 'ERROR',
151:         error: failed.length + ' média(s) non téléchargé(s) — relance manuelle du téléchargement possible',
152:         medias: completion.medias
153:       };
154:     }
155: 
156:     log('success', 'Tous les médias téléchargés');
157:     return {
158:       status: 'COMPLETED',
159:       medias: completion.medias,
160:       downloadResults: dlResult.results
161:     };
162:   }
163: 
164:   function sleep(ms) {
165:     return new Promise((resolve) => setTimeout(resolve, ms));
166:   }
167: 
168:   // --- Exposition du pipeline ---
169:   queue.setPipeline(processPrompt);
170: 
171:   // --- Diffusion de l'état de la file vers les autres contextes ---
172:   function broadcastQueue() {
173:     const st = queue.getState();
174:     chrome.runtime.sendMessage({ type: 'QUEUE_SNAPSHOT', value: st }).catch(() => {});
175:   }
176:   queue.onChange(broadcastQueue);
177: 
178:   // --- Messages reçus (popup / background) ---
179:   chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
180:     switch (message && message.type) {
181:       case 'CHECK_FLOW_PAGE':
182:         sendResponse({ ok: true, isFlowPage: dom.isFlowPage(), hasPrompt: dom.hasPromptTextarea() });
183:         return;
184: 
185:       case 'GET_PAGE_STATE': {
186:         const snap = generation.snapshot();
187:         sendResponse({
188:           ok: true,
189:           isFlowPage: dom.isFlowPage(),
190:           isInProject: dom.isInProject(),
191:           hasPrompt: dom.hasPromptTextarea(),
192:           tiles: snap.count,
193:           medias: snap.medias.length,
194:           percent: snap.percent
195:         });
196:         return;
197:       }
198: 
199:       // --- Contrôles de la file ---
200:       case 'QUEUE_CREATE':
201:         queue.create(message.prompts);
202:         sendResponse({ ok: true });
203:         return;
204: 
205:       case 'QUEUE_START':
206:         queue.start();
207:         sendResponse({ ok: true });
208:         return;
209: 
210:       case 'QUEUE_PAUSE':
211:         queue.pause();
212:         sendResponse({ ok: true });
213:         return;
214: 
215:       case 'QUEUE_RESUME':
216:         queue.resume();
217:         sendResponse({ ok: true });
218:         return;
219: 
220:       case 'QUEUE_CANCEL':
221:         queue.cancel();
222:         sendResponse({ ok: true });
223:         return;
224: 
225:       case 'QUEUE_GET':
226:         sendResponse({ ok: true, value: queue.getState() });
227:         return;
228: 
229:       case 'PING':
230:         sendResponse({ ok: true, pong: true });
231:         return;
232: 
233:       default:
234:         // ne pas répondre
235:         return;
236:     }
237:   });
238: 
239:   // --- Initialisation ---
240:   (async function init() {
241:     await loadSelectors();
242:     // restaure la file et inspecte les éventuels prompts interrompus
243:     const restored = await queue.restore();
244:     if (restored.restored) {
245:       queue.inspectInterrupted(dom, generation);
246:       storage.appendLog('info', 'File restaurée depuis le storage');
247:     }
248:     storage.appendLog('info', 'Content script prêt');
249:     queue.notify();
250:   })();
251: })();
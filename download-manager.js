/**
 * download-manager.js
 * Téléchargement des médias générés.
 *
 * Rôle :
 *  - recevoir une liste de médias { url, type }
 *  - vérifier l'accessibilité (generation.checkMediaAccess)
 *  - initier le téléchargement via le background (chrome.downloads)
 *  - nommer proprement chaque fichier (promptIndex + slug + extension)
 *  - retourner un rapport par média { ok, error, filename, downloadId }
 *
 * NE JAMAIS relancer une génération en cas d'échec de téléchargement :
 * on conserve l'URL et on signale l'échec pour une nouvelle tentative manuelle.
 */

(function () {
  'use strict';

  if (typeof window.FlowAutomation === 'undefined') {
    window.FlowAutomation = {};
  }
  const generation = window.FlowAutomation.generation;

  const download = {};

  /**
   * Convertit un texte en slug sûr pour nom de fichier.
   */
  download.slugify = function (text, maxLen) {
    const t = String(text || '')
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    const max = maxLen || 50;
    return t.substring(0, max) || 'prompt';
  };

  /**
   * Nom de fichier recommandé pour un média.
   */
  download.buildFilename = function (promptIndex, prompt, media, folder) {
    const ext = media.type === 'video' ? 'mp4' : 'jpg';
    const slug = download.slugify(prompt);
    const idx = String(promptIndex).padStart(3, '0');
    const base = folder ? `${folder}/` : '';
    return `${base}${idx}_${slug}.${ext}`;
  };

  /**
   * Initie le téléchargement d'un média via le background.
   * Retourne { ok, error, filename, downloadId }.
   */
  download.trigger = async function (url, filename) {
    const resp = await chrome.runtime.sendMessage({
      type: 'DOWNLOAD_MEDIA',
      url,
      filename,
      folder: null
    }).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
    return resp && resp.ok
      ? { ok: true, downloadId: resp.downloadId, filename, url }
      : { ok: false, error: (resp && resp.error) || 'download failed', filename, url };
  };

  /**
   * Télécharge une liste de médias avec vérification préalable.
   * Retourne { results, allOk }.
   * options : { promptIndex, prompt, folder, verifyAccess }
   */
  download.downloadMedias = async function (medias, options) {
    const opts = options || {};
    const results = [];
    let allOk = true;

    for (const media of medias) {
      // vérification d'accès (best-effort)
      if (opts.verifyAccess !== false) {
        const check = await generation.checkMediaAccess(media.url);
        // Un statut HTTP explicite en erreur (404, 403...) = média indisponible :
        // inutile de tenter le téléchargement.
        // Un échec "cors-or-network" (status -1) n'est PAS définitif : le
        // background possède les host_permissions et peut télécharger malgré
        // le blocage CORS du content script. On tente donc quand même.
        if (!check.ok && typeof check.status === 'number' && check.status > 0) {
          results.push({
            url: media.url,
            type: media.type,
            ok: false,
            warning: 'Access check failed (HTTP ' + check.status + ')',
            verified: false
          });
          allOk = false;
          continue;
        }
      }

      const filename = download.buildFilename(
        opts.promptIndex, opts.prompt, media, opts.folder
      );
      const res = await download.trigger(media.url, filename);
      res.type = media.type;
      res.verified = opts.verifyAccess !== false;
      if (!res.ok) allOk = false;
      results.push(res);
    }

    return { results, allOk };
  };

  window.FlowAutomation.download = download;
})();

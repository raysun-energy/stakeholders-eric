// Bouton « Support » dans l'en-tête de chaque page : signaler un bug ou demander une amélioration.
// La demande, avec ses captures d'écran, devient une tâche dans l'Odoo d'Eric et lui est envoyée par e-mail.
(() => {
  const bar = document.querySelector('.topbar .user');
  if (!bar || typeof sb === 'undefined') return;
  const btn = document.createElement('button');
  btn.type = 'button'; btn.id = 'support-open'; btn.textContent = 'Support';
  // Sur la carte : un bouton à côté de « + Proposer un lieu ». Sur les autres pages : un lien dans l'en-tête.
  // (en bas à gauche de la carte, pour rester visible quand une fiche est ouverte à droite)
  const fabs = document.querySelector('.map-wrap');
  if (fabs) { btn.className = 'fab fab-support'; btn.title = 'Signaler un bug ou demander une amélioration'; fabs.appendChild(btn); }
  else { btn.className = 'link'; bar.insertBefore(btn, bar.lastElementChild); }

  const dlg = document.createElement('dialog');
  dlg.id = 'support-dialog';
  dlg.innerHTML = `
    <form method="dialog" id="support-form">
      <h2>Support</h2>
      <p class="muted small">Un bug, une idée d’amélioration ? Décrivez-le ici, l’équipe RaYSun le reçoit directement.</p>
      <div class="support-kind">
        <label><input type="radio" name="kind" value="Bug" checked> Signaler un bug</label>
        <label><input type="radio" name="kind" value="Amélioration"> Demander une amélioration</label>
      </div>
      <textarea name="message" rows="6" maxlength="4000" required placeholder="Ce que vous faisiez, ce qui s’est passé, ce que vous attendiez…"></textarea>
      <label class="small support-files">Captures d’écran (facultatif, 3 au plus) : choisissez des images ou collez-les ici avec Ctrl+V
        <input type="file" id="support-files" accept="image/png,image/jpeg,image/webp,image/gif" multiple>
      </label>
      <ul class="small" id="support-list"></ul>
      <p class="small" id="support-msg"></p>
      <div class="support-actions">
        <button type="button" class="btn secondary" id="support-cancel">Fermer</button>
        <button type="submit" class="btn primary" id="support-send">Envoyer</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  const form = dlg.querySelector('form'), msg = dlg.querySelector('#support-msg'), send = dlg.querySelector('#support-send');

  // Captures : fichiers choisis ou images collées, 3 au plus, 5 Mo chacune.
  let shots = [];
  const list = dlg.querySelector('#support-list'), input = dlg.querySelector('#support-files');
  const renderShots = () => {
    list.innerHTML = shots.map((f, k) => `<li>${f.name.replace(/[<>&]/g, '')} <button type="button" class="link" data-k="${k}">Retirer</button></li>`).join('');
    list.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { shots.splice(Number(b.dataset.k), 1); renderShots(); }));
  };
  const addShots = (files) => {
    for (const f of files) {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) continue;
      if (f.size > 5 * 1024 * 1024) { msg.className = 'small error'; msg.textContent = 'Image trop lourde (5 Mo au plus).'; continue; }
      if (shots.length >= 3) { msg.className = 'small error'; msg.textContent = 'Trois captures au plus.'; break; }
      shots.push(f);
    }
    renderShots();
  };
  input.addEventListener('change', () => { addShots(input.files); input.value = ''; });
  dlg.addEventListener('paste', (e) => {
    const imgs = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (imgs.length) { e.preventDefault(); addShots(imgs); }
  });

  btn.addEventListener('click', async () => {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;                       // pas connecté : rien à envoyer
    msg.textContent = ''; msg.className = 'small'; send.hidden = false; form.message.disabled = false;
    dlg.showModal();
  });
  dlg.querySelector('#support-cancel').addEventListener('click', () => dlg.close());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = form.message.value.trim();
    if (!text) return;
    send.disabled = true;
    msg.className = 'small muted'; msg.textContent = 'Envoi en cours…';
    const { data: { session } } = await sb.auth.getSession();
    const paths = [];
    let error = null;
    for (const f of shots) {
      const path = `${session.user.id}/${crypto.randomUUID()}.${{ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[f.type]}`;
      ({ error } = await sb.storage.from('amb-support').upload(path, f, { contentType: f.type }));
      if (error) break;
      paths.push(path);
    }
    if (!error) ({ error } = await sb.from('amb_support').insert({ kind: form.kind.value, message: text, page: location.pathname.split('/').pop() || 'carte', screenshots: paths }));
    send.disabled = false;
    if (error) { console.error(error); msg.className = 'small error'; msg.textContent = 'L’envoi a échoué. Réessayez dans un instant.'; return; }
    msg.className = 'small'; msg.textContent = 'Merci, votre message est bien arrivé.';
    form.message.value = ''; shots = []; renderShots(); send.hidden = true;
  });
})();

// Bouton « Support » dans l'en-tête de chaque page : signaler un bug ou demander une amélioration.
// La demande est enregistrée (table amb_support), listée dans le suivi équipe et envoyée par e-mail à l'équipe.
(() => {
  const bar = document.querySelector('.topbar .user');
  if (!bar || typeof sb === 'undefined') return;
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'link'; btn.id = 'support-open'; btn.textContent = 'Support';
  bar.insertBefore(btn, bar.lastElementChild);

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
      <p class="small" id="support-msg"></p>
      <div class="support-actions">
        <button type="button" class="btn secondary" id="support-cancel">Fermer</button>
        <button type="submit" class="btn primary" id="support-send">Envoyer</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  const form = dlg.querySelector('form'), msg = dlg.querySelector('#support-msg'), send = dlg.querySelector('#support-send');

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
    const { error } = await sb.from('amb_support').insert({ kind: form.kind.value, message: text, page: location.pathname.split('/').pop() || 'carte' });
    send.disabled = false;
    if (error) { console.error(error); msg.className = 'small error'; msg.textContent = 'L’envoi a échoué. Réessayez dans un instant.'; return; }
    msg.className = 'small'; msg.textContent = 'Merci, votre message est bien arrivé.';
    form.message.value = ''; send.hidden = true;
  });
})();

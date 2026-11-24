# Construit la version en ligne du sales book (site/salesbook.html + site/salesbook/) à partir de book.html.
import re, os, shutil
from PIL import Image
SITE='/home/user/stakeholders-eric/site'; OUT=SITE+'/salesbook'; os.makedirs(OUT, exist_ok=True)
s=open('book.html').read()
css=s[s.index('<style>')+7:s.index('</style>')]
body=s[s.index('<body>')+6:s.index('<script>')]
# Images : converties en WebP, renommées sans espace
def img(m):
    src=m.group(1); name=re.sub(r'[^a-z0-9]+','-',os.path.splitext(src)[0].lower()).strip('-')
    if src.endswith('.svg'):
        shutil.copy(src, f'{OUT}/{name}.svg'); return f'src="salesbook/{name}.svg"'
    im=Image.open(src)
    if im.mode in ('RGBA','P','LA'): im=im.convert('RGBA')
    else: im=im.convert('RGB')
    im.save(f'{OUT}/{name}.webp', 'WEBP', quality=86, method=6)
    return f'src="salesbook/{name}.webp"'
body=re.sub(r'src="([^"]+)"', img, body)
html=f'''<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sales book apporteurs d'affaires · RaYSun</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Carlito:wght@400;700&display=swap" rel="stylesheet">
<!-- Page générée par le script du sales book : le contenu des diapositives est le même que le PDF.
 -->
<style>
{css}
/* --- Affichage à l'écran : diapositives mises à l'échelle de la fenêtre --- */
body {{ background: #EDE7DA; }}
.bar {{ position: sticky; top: 0; z-index: 10; background: #12130F; color: #fff; display: flex; gap: 14px; align-items: center; flex-wrap: wrap; padding: 10px 18px; font-size: 15px; }}
.bar b {{ margin-right: auto; }} .bar a {{ color: #F5A623; }}
.bar button {{ font: inherit; font-weight: 700; border: 0; border-radius: 99px; padding: 8px 16px; background: #F5A623; color: #12130F; cursor: pointer; }}
.bar .maj {{ color: #BDB8AE; font-size: 13px; }}
#deck {{ width: calc(960px * var(--k, 1)); margin: 18px auto 40px; }}
#deck .s {{ transform-origin: top left; transform: scale(var(--k, 1)); margin-bottom: calc(540px * (var(--k, 1) - 1) + 14px); box-shadow: 0 4px 18px rgba(18,19,15,.18); border-radius: 6px; }}
#gate {{ max-width: 520px; margin: 80px auto; background: #fff; border-radius: 16px; padding: 24px; font-size: 16px; }}
@media print {{
  body {{ background: #fff; }} .bar, #gate {{ display: none !important; }}
  #deck {{ width: 960px; margin: 0; }} #deck .s {{ transform: none; margin: 0; box-shadow: none; border-radius: 0; }}
}}
</style>
</head>
<body>
<div class="bar" id="bar" hidden><b>Sales book apporteurs d'affaires</b><a href="./">Carte</a><a href="dossiers.html">Dossiers</a><button type="button" id="pdf">Télécharger le PDF</button></div>
<div id="gate">Chargement…</div>
<div id="deck" hidden>
{body}
</div>
<script src="vendor/supabase.js"></script>
<script src="config.js"></script>
<script src="auth.js"></script>
<script>
function fit() {{ document.documentElement.style.setProperty('--k', Math.min(1.6, (document.documentElement.clientWidth - 24) / 960)); }}
addEventListener('resize', fit); fit();
document.querySelectorAll('#deck .s').forEach((x, k) => {{ const n = x.querySelector('.pn'); if (n) n.textContent = String(k + 1).padStart(2, '0'); }});
document.getElementById('pdf').addEventListener('click', () => print());

(async () => {{
  const gate = document.getElementById('gate');
  const who = await currentMember().catch(() => null);
  if (!who) {{ gate.innerHTML = 'Connectez-vous d’abord sur <a href="dossiers.html">la plateforme apporteurs</a>, puis revenez sur cette page.'; return; }}
  if (!['admin', 'apporteur'].includes(who.member?.role)) {{ gate.textContent = 'Ce document est réservé aux apporteurs d’affaires de RaYSun.'; return; }}
  gate.hidden = true; document.getElementById('deck').hidden = false; document.getElementById('bar').hidden = false;
}})();
</script>
</body>
</html>
'''
open(SITE+'/salesbook.html','w').write(html)
print(len(html)//1024, 'Ko', len(os.listdir(OUT)), 'images', sum(os.path.getsize(OUT+'/'+f) for f in os.listdir(OUT))//1024, 'Ko')

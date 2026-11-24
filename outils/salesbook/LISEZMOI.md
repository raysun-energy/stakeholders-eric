Sources du sales book des apporteurs d'affaires.

- `book.html` : les diapositives (960 x 540, format peer review). C'est la source du PDF et de la page en ligne.
- `captures.js` : captures d'écran de la plateforme en vue apporteur, avec des données fictives.
- `pdf.js` : conversion en PDF avec Playwright.
- `build_site.py` : génère `site/salesbook.html` et `site/salesbook/` (images en WebP).

Les images (`shots/`, `storm/`, logos) ne sont pas dans le dépôt : elles sont déjà converties dans `site/salesbook/`.
Les chemins des scripts pointent vers le dossier de travail d'origine ; les adapter avant de relancer.

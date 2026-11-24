Fonction déployée le 24/11/2026 pour déposer le sales book des apporteurs dans Odoo Connaissances (article 488).
Elle refuse tout appel sans jeton valide dans la table `amb_doc_jeton` (vide par défaut) : pour la réutiliser,
insérer un jeton à durée limitée, appeler la fonction avec l'en-tête `x-doc-token`, puis vider la table.
Opérations autorisées : knowledge.article (read, create, write) et ir.attachment (create). Aucune suppression.

# Dynasty VOR · Fantrax points

**Site :** https://samuellachance.github.io/fantasy-hockey-dynasty-vor/

Classement de tous les joueurs de la LNH pour une ligue Fantrax dynasty par points (sans plafond salarial), avec la même méthode VOR que [fantasy-hockey-vor](https://samuellachance.github.io/fantasy-hockey-vor/), convertie en points et ajustée à l'âge.

- `scripts/build_data.py` : projections de base du modèle fantasy-hockey-vor + stats de l'API LNH → `site/data.json` (Python, bibliothèque standard seulement).
- `site/` : page statique ; le VOR se calcule dans le navigateur (nombre d'équipes modifiable).
- `.github/workflows/deploy.yml` : reconstruit les données et publie `site/` sur la branche `gh-pages` (GitHub Pages) à chaque push et deux fois par jour.

Tester localement :

```bash
python scripts/build_data.py        # OFFLINE=1 pour utiliser seulement les fichiers de data/
cd site && python -m http.server
```

Détails de la méthode : onglet « Méthode » du site.

# Gazole malin

Page web qui trouve la station **la plus rentable**, pas seulement la moins chère :
le coût du trajet aller-retour jusqu'à la station est ajouté au prix du plein.

```
coût total = prix × litres du plein + prix × conso/100 × distance aller-retour
```

Exemple : 5 cts/L d'écart sur 40 L = 2 €, ce qui paie au maximum ~10 km aller (à 5,8 L/100 et 1,70 €/L).

## Fonctionnement

- **Départ** : adresse (autocomplétion Géoplateforme IGN) ou position actuelle du téléphone.
- **Prix** : API temps réel `prix-des-carburants-en-france-flux-instantane-v2` de data.economie.gouv.fr
  (mise à jour ~10 min), appelée directement depuis le navigateur. Les prix de plus de 8 jours sont ignorés.
- **Secours** : la GitHub Action publie toutes les heures une copie complète des prix (`data/stations.json`),
  utilisée si l'API ne répond pas.
- **Distances** : vol d'oiseau × 1,3 pour toutes les stations du rayon, puis distance routière réelle
  (serveur public OSRM) pour les 25 meilleures et la plus proche.
- **Réglages** (carburant, conso, litres, rayon) : gardés dans le navigateur.

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `cost.js` | Calcul de rentabilité (fonctions pures) |
| `data.js` | Appels aux API (prix, adresses, routes) |
| `app.js` | Interface |
| `scripts/build.sh` | Construit `_site/` et télécharge la copie des prix |
| `.github/workflows/deploy.yml` | Tests + publication GitHub Pages à chaque push et toutes les heures |

## En local

```
node test/cost.test.mjs   # tests du calcul
python3 -m http.server    # puis http://localhost:8000
```

Note : GitHub suspend les tâches planifiées d'un repo sans activité pendant 60 jours.
Il suffit alors de relancer le workflow depuis l'onglet Actions.

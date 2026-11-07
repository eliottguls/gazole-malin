#!/usr/bin/env bash
# Construit le site dans _site/ avec une copie des prix (fichier de secours de l'app).
set -euo pipefail
API="https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2"
FIELDS="id,adresse,ville,cp,geom"
for f in gazole e10 sp95 sp98 e85 gplc; do FIELDS="$FIELDS,${f}_prix,${f}_maj"; done

rm -rf _site && mkdir -p _site/data
cp index.html app.js cost.js data.js style.css _site/
touch _site/.nojekyll

curl -fsS --retry 3 --compressed -G "$API/exports/json" \
  --data-urlencode "select=$FIELDS" -o _site/data/stations.json
COUNT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('_site/data/stations.json')).length)")
echo "Stations exportées : $COUNT"
[ "$COUNT" -gt 5000 ] || { echo "Export suspect (moins de 5000 stations)"; exit 1; }

# Vérifie que la requête géographique utilisée par l'app fonctionne (Rennes, 5 km)
curl -fsS -G "$API/records" \
  --data-urlencode "where=within_distance(geom, geom'POINT(-1.6778 48.1173)', 5km) and gazole_prix is not null" \
  --data-urlencode "select=id,adresse,ville,geom,gazole_prix,gazole_maj" \
  --data-urlencode "limit=3" | tee /tmp/sample.json
echo
node -e "const j=JSON.parse(require('fs').readFileSync('/tmp/sample.json'));if(!j.total_count)process.exit(1);console.log('Requête géo OK :',j.total_count,'stations')"
